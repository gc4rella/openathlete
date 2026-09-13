import {
  MutationOptions,
  QueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { TrainingPlanAPI } from './training-plan.api';
import { trainingPlanKeys } from './training-plan.keys';

export const useChatGptPlannerProviderQuery = (
  enabled: boolean,
  pollUntilConnected = false,
) =>
  useQuery({
    queryKey: [trainingPlanKeys.plannerProvider],
    queryFn: TrainingPlanAPI.plannerProvider,
    enabled,
    refetchInterval: (query) =>
      pollUntilConnected && !query.state.data?.connected ? 2000 : false,
  });

export const useChatGptPlannerLoginMutation = (
  opt?: MutationOptions<
    Awaited<ReturnType<typeof TrainingPlanAPI.startPlannerProviderLogin>>,
    Error,
    void
  >,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    ...opt,
    mutationFn: TrainingPlanAPI.startPlannerProviderLogin,
    onSuccess: (data, variables, onMutateResult, context) => {
      if (opt?.onSuccess) {
        opt.onSuccess(data, variables, onMutateResult, context);
      }
      queryClient.invalidateQueries({
        queryKey: [trainingPlanKeys.plannerProvider],
      });
    },
  });
};

export const useTrainingPlansQuery = (
  athleteId?: number,
  opt?: QueryOptions<Awaited<ReturnType<typeof TrainingPlanAPI.list>>>,
) =>
  useQuery({
    ...opt,
    queryKey: [trainingPlanKeys.list, athleteId],
    queryFn: () => TrainingPlanAPI.list(athleteId),
  });

export const useCurrentTrainingPlanQuery = (
  athleteId?: number,
  opt?: QueryOptions<Awaited<ReturnType<typeof TrainingPlanAPI.current>>>,
) =>
  useQuery({
    ...opt,
    queryKey: [trainingPlanKeys.current, athleteId],
    queryFn: () => TrainingPlanAPI.current(athleteId),
  });

export const useTrainingPlanQuery = (
  trainingPlanId: number | undefined,
  opt?: QueryOptions<Awaited<ReturnType<typeof TrainingPlanAPI.get>>>,
) =>
  useQuery({
    ...opt,
    enabled: trainingPlanId !== undefined,
    queryKey: [trainingPlanKeys.get, trainingPlanId],
    queryFn: () => TrainingPlanAPI.get(trainingPlanId as number),
  });

export const useTrainingPlanAdjustmentsQuery = (
  trainingPlanId: number | undefined,
  opt?: QueryOptions<Awaited<ReturnType<typeof TrainingPlanAPI.adjustments>>>,
) =>
  useQuery({
    ...opt,
    enabled: trainingPlanId !== undefined,
    queryKey: [trainingPlanKeys.adjustments, trainingPlanId],
    queryFn: () => TrainingPlanAPI.adjustments(trainingPlanId as number),
  });

/**
 * Preview is a mutation rather than a query: it is an explicit action the
 * athlete takes ("show me a plan"), it is not cached, and re-running it with
 * the same inputs is expected to be allowed.
 */
export const usePreviewTrainingPlanMutation = (
  opt?: MutationOptions<
    Awaited<ReturnType<typeof TrainingPlanAPI.preview>>,
    Error,
    Parameters<typeof TrainingPlanAPI.preview>[0]
  >,
) =>
  useMutation({
    ...opt,
    mutationFn: TrainingPlanAPI.preview,
  });

export const useTrainingPlanIntakeMutation = (
  opt?: MutationOptions<
    Awaited<ReturnType<typeof TrainingPlanAPI.intake>>,
    Error,
    Parameters<typeof TrainingPlanAPI.intake>[0]
  >,
) =>
  useMutation({
    ...opt,
    mutationFn: TrainingPlanAPI.intake,
  });

export const useCreateTrainingPlanMutation = (
  opt?: MutationOptions<
    Awaited<ReturnType<typeof TrainingPlanAPI.create>>,
    Error,
    Parameters<typeof TrainingPlanAPI.create>[0]
  >,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    ...opt,
    mutationFn: TrainingPlanAPI.create,
    onSuccess: (data, variables, onMutateResult, context) => {
      if (opt?.onSuccess) {
        opt.onSuccess(data, variables, onMutateResult, context);
      }
      queryClient.invalidateQueries({ queryKey: [trainingPlanKeys.list] });
      queryClient.invalidateQueries({ queryKey: [trainingPlanKeys.current] });
      // A new plan writes sessions into the calendar.
      queryClient.invalidateQueries({ queryKey: ['EventAPI.getMyEvents'] });
    },
  });
};

export const useUpdateTrainingPlanMutation = (
  opt?: MutationOptions<
    Awaited<ReturnType<typeof TrainingPlanAPI.update>>,
    Error,
    Parameters<typeof TrainingPlanAPI.update>[0]
  >,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    ...opt,
    mutationFn: TrainingPlanAPI.update,
    onSuccess: (data, variables, onMutateResult, context) => {
      if (opt?.onSuccess) {
        opt.onSuccess(data, variables, onMutateResult, context);
      }
      queryClient.invalidateQueries({ queryKey: [trainingPlanKeys.list] });
      queryClient.invalidateQueries({ queryKey: [trainingPlanKeys.current] });
      queryClient.invalidateQueries({ queryKey: [trainingPlanKeys.get] });
    },
  });
};

export const useDeleteTrainingPlanMutation = (
  opt?: MutationOptions<
    Awaited<ReturnType<typeof TrainingPlanAPI.remove>>,
    Error,
    Parameters<typeof TrainingPlanAPI.remove>[0]
  >,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    ...opt,
    mutationFn: TrainingPlanAPI.remove,
    onSuccess: (data, variables, onMutateResult, context) => {
      if (opt?.onSuccess) {
        opt.onSuccess(data, variables, onMutateResult, context);
      }
      queryClient.invalidateQueries({ queryKey: [trainingPlanKeys.list] });
      queryClient.invalidateQueries({ queryKey: [trainingPlanKeys.current] });
      queryClient.invalidateQueries({ queryKey: ['EventAPI.getMyEvents'] });
    },
  });
};
