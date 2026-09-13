import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  type ChatGptPlannerLoginResponse,
  type ChatGptPlannerProviderStatus,
  type PlanIntakeResponse,
  planIntakeResponseSchema,
} from '@openathlete/shared';

const RPC_TIMEOUT_MS = 15_000;
const GENERATION_TIMEOUT_MS = 60_000;

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type CodexAccountResponse = {
  account: null | {
    type: 'apiKey' | 'chatgpt' | 'amazonBedrock';
    planType?: string;
  };
  requiresOpenaiAuth: boolean;
};

type CodexTurn = {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message?: string } | null;
  items: Array<{ type: string; text?: string }>;
};

/**
 * Small JSON-RPC client for the official Codex app-server.
 *
 * Codex owns the managed ChatGPT OAuth tokens and refresh flow. OpenAthlete
 * never receives or stores those tokens; it only talks to the local runtime.
 * The runtime account is instance-scoped, so this provider is deliberately
 * opt-in and intended for a trusted personal/self-hosted OpenAthlete server.
 */
@Injectable()
export class ChatGptPlannerProviderService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatGptPlannerProviderService.name);
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private startPromise: Promise<void> | null = null;
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly completedTurns = new Map<string, CodexTurn>();
  private readonly turnWaiters = new Map<
    string,
    {
      resolve: (turn: CodexTurn) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  async status(): Promise<ChatGptPlannerProviderStatus> {
    if (!this.isEnabled()) return disconnectedStatus(false, false);

    try {
      const account = await this.readAccount(false);
      const connected = account.account?.type === 'chatgpt';

      return {
        provider: 'chatgpt-codex',
        scope: 'instance',
        enabled: true,
        available: true,
        connected,
        planType: connected ? (account.account?.planType ?? null) : null,
      };
    } catch (error) {
      this.logger.warn(
        `Codex app-server is unavailable: ${errorMessage(error)}`,
      );
      return disconnectedStatus(true, false);
    }
  }

  async startLogin(): Promise<ChatGptPlannerLoginResponse> {
    this.assertEnabled();
    const response = await this.request<{
      type: string;
      loginId?: string;
      verificationUrl?: string;
      userCode?: string;
    }>('account/login/start', { type: 'chatgptDeviceCode' });

    if (
      response.type !== 'chatgptDeviceCode' ||
      !response.loginId ||
      !response.verificationUrl ||
      !response.userCode
    ) {
      throw new ServiceUnavailableException(
        'CHATGPT_PLANNER_LOGIN_UNAVAILABLE',
      );
    }

    return {
      loginId: response.loginId,
      verificationUrl: response.verificationUrl,
      userCode: response.userCode,
    };
  }

  async generate(prompt: string): Promise<PlanIntakeResponse> {
    this.assertEnabled();
    const account = await this.readAccount(true);
    if (account.account?.type !== 'chatgpt') {
      throw new ServiceUnavailableException('CHATGPT_PLANNER_AUTH_REQUIRED');
    }

    const model = process.env.CODEX_PLANNER_MODEL?.trim();
    const started = await this.request<{
      thread: { id: string };
    }>('thread/start', {
      ...(model ? { model } : {}),
      cwd: process.env.CODEX_PLANNER_CWD?.trim() || tmpdir(),
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      serviceName: 'OpenAthlete planning intake',
      baseInstructions: PLAN_INTAKE_INSTRUCTIONS,
      developerInstructions:
        'Return only the requested structured response. Do not run commands, read files, browse, call tools, or modify anything.',
    });
    const threadId = started.thread.id;

    try {
      const turnStarted = await this.request<{ turn: { id: string } }>(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          effort: 'low',
          outputSchema: PLAN_INTAKE_OUTPUT_SCHEMA,
        },
      );
      const turn = await this.waitForTurn(turnStarted.turn.id);

      if (turn.status !== 'completed') {
        throw new Error(turn.error?.message || `Codex turn ${turn.status}`);
      }

      const text = [...turn.items]
        .reverse()
        .find((item) => item.type === 'agentMessage')?.text;
      if (!text) throw new Error('Codex returned no planner response');

      return planIntakeResponseSchema.parse(JSON.parse(text));
    } finally {
      void this.request('thread/delete', { threadId }).catch(() => undefined);
    }
  }

  onModuleDestroy() {
    this.child?.kill();
    this.failProcess(new Error('Codex app-server stopped'));
  }

  private isEnabled() {
    return process.env.CHATGPT_PLANNER_ENABLED === 'true';
  }

  private assertEnabled() {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('CHATGPT_PLANNER_DISABLED');
    }
  }

  private async readAccount(refreshToken: boolean) {
    return this.request<CodexAccountResponse>('account/read', { refreshToken });
  }

  private async request<T = unknown>(method: string, params?: unknown) {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params);
  }

  private async ensureStarted() {
    if (this.child && this.ready) return;
    if (!this.startPromise) this.startPromise = this.start();

    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw new ServiceUnavailableException(
        `CHATGPT_PLANNER_RUNTIME_UNAVAILABLE: ${errorMessage(error)}`,
      );
    }
  }

  private async start() {
    const executable = process.env.CODEX_BIN?.trim() || 'codex';
    const child = spawn(executable, ['app-server', '--stdio'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.ready = false;
    this.stdoutBuffer = '';

    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) this.logger.debug(message);
    });
    child.once('error', (error) => this.failProcess(error, child));
    child.once('exit', (code, signal) =>
      this.failProcess(
        new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`),
        child,
      ),
    );

    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'openathlete',
        title: 'OpenAthlete',
        version: '1.0.0',
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: 'initialized' });
    this.ready = true;
    this.startPromise = null;
  }

  private sendRequest<T = unknown>(method: string, params?: unknown) {
    const id = this.nextRequestId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: JsonRpcMessage) {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: Buffer) {
    this.stdoutBuffer += chunk.toString();

    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;

      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage);
      } catch (error) {
        this.logger.warn(
          `Invalid Codex app-server message: ${errorMessage(error)}`,
        );
      }
    }
  }

  private handleMessage(message: JsonRpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message || 'Codex request failed'),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === 'turn/completed') {
      const params = message.params as { turn?: CodexTurn } | undefined;
      if (params?.turn) this.completeTurn(params.turn);
      return;
    }

    // Planning turns are intentionally non-interactive and tool-free. Reject
    // any unexpected server request instead of leaving the runtime blocked.
    if (message.id !== undefined && message.method) {
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported planner request: ${message.method}`,
        },
      });
    }
  }

  private waitForTurn(turnId: string) {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }

    return new Promise<CodexTurn>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error('Codex planning turn timed out'));
      }, GENERATION_TIMEOUT_MS);
      this.turnWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  private completeTurn(turn: CodexTurn) {
    const waiter = this.turnWaiters.get(turn.id);
    if (!waiter) {
      this.completedTurns.set(turn.id, turn);
      return;
    }

    clearTimeout(waiter.timer);
    this.turnWaiters.delete(turn.id);
    waiter.resolve(turn);
  }

  private failProcess(
    error: Error,
    expectedChild?: ChildProcessWithoutNullStreams,
  ) {
    if (expectedChild && this.child !== expectedChild) return;
    this.child = null;
    this.ready = false;
    this.startPromise = null;

    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();

    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.turnWaiters.clear();
    this.completedTurns.clear();
  }
}

function disconnectedStatus(
  enabled: boolean,
  available: boolean,
): ChatGptPlannerProviderStatus {
  return {
    provider: 'chatgpt-codex',
    scope: 'instance',
    enabled,
    available,
    connected: false,
    planType: null,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const PLAN_INTAKE_INSTRUCTIONS = `You are the intake coach for OpenAthlete.

Have a short, natural conversation that gathers the facts needed to build a running plan. Do not design workouts, prescribe paces, assess medical safety, or promise a result. A deterministic engine validates and builds the plan after the athlete confirms the brief.

- Write only in the requested language (EN, FR, or IT).
- Ask at most two closely related questions at a time.
- Never ask for data the context says is already known.
- Convert 5K, 10K, half marathon, and marathon to 5000, 10000, 21097, and 42195 meters.
- Convert finish times to seconds. dayOfWeek is Sunday=0 through Saturday=6. Weekly volume is seconds.
- If known currentWeeklyVolumeSeconds is non-null, copy it and do not ask for it.
- Goal time, long-run day, cross-training, and plan name are optional.
- If injury is mentioned, keep injuryAware true without diagnosing.
- Race plans require goal kind, start date, race date, distance, days per week, and weekly volume, with at least four full weeks before the race.
- General fitness plans require goal kind, start date, duration, days per week, and weekly volume.
- Preserve earlier values unless the athlete changes them. Unknowns are null. Defaults: includeCrossTraining=false and injuryAware=true.`;

const nullable = (type: 'string' | 'number' | 'integer') => ({
  type: [type, 'null'],
});

const PLAN_INTAKE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'ready', 'missingFields', 'draft'],
  properties: {
    message: { type: 'string' },
    ready: { type: 'boolean' },
    missingFields: { type: 'array', items: { type: 'string' } },
    draft: {
      type: 'object',
      additionalProperties: false,
      required: [
        'goalKind',
        'startDate',
        'raceDate',
        'targetDistance',
        'targetTime',
        'durationWeeks',
        'daysPerWeek',
        'longRunDay',
        'currentWeeklyVolume',
        'includeCrossTraining',
        'injuryAware',
        'planName',
      ],
      properties: {
        goalKind: {
          type: ['string', 'null'],
          enum: ['RACE', 'GENERAL_FITNESS', null],
        },
        startDate: nullable('string'),
        raceDate: nullable('string'),
        targetDistance: nullable('number'),
        targetTime: nullable('integer'),
        durationWeeks: nullable('integer'),
        daysPerWeek: nullable('integer'),
        longRunDay: nullable('integer'),
        currentWeeklyVolume: nullable('number'),
        includeCrossTraining: { type: 'boolean' },
        injuryAware: { type: 'boolean' },
        planName: nullable('string'),
      },
    },
  },
};
