import { CYCLE_PHASE, type CreateWorkoutStepDto, WORKOUT_TARGET_TYPE, WORKOUT_STEP_TYPE } from '@openathlete/shared';

import { formatPace } from './physiology';
import { type ArchetypeKey } from './session-templates';
import { type PaceTable, RunIntensity, type WeekSkeleton } from './types';

/**
 * Deterministic prose
 *
 * Names, themes and descriptions for a generated plan, in every language the
 * app supports.
 *
 * This is the fallback the LLM narrative pass *replaces*, not the other way
 * round: plan generation must work with no AI provider configured at all, so a
 * self-hosted instance without an API key still produces a complete, readable
 * plan. When the narrative agent does run, it may rewrite these strings - and
 * nothing else.
 */

export type Language = 'EN' | 'FR' | 'IT';

type Translations = Record<Language, string>;

const SESSION_NAMES: Record<ArchetypeKey, Translations> = {
  recovery: {
    EN: 'Recovery run',
    FR: 'Footing de récupération',
    IT: 'Corsa di recupero',
  },
  easy: { EN: 'Easy run', FR: 'Footing', IT: 'Corsa facile' },
  'easy-strides': {
    EN: 'Easy run + strides',
    FR: 'Footing + lignes droites',
    IT: 'Corsa facile + allunghi',
  },
  'long-run': { EN: 'Long run', FR: 'Sortie longue', IT: 'Lungo' },
  'progressive-long-run': {
    EN: 'Progressive long run',
    FR: 'Sortie longue progressive',
    IT: 'Lungo progressivo',
  },
  threshold: { EN: 'Tempo run', FR: 'Séance au seuil', IT: 'Medio / soglia' },
  'cruise-intervals': {
    EN: 'Cruise intervals',
    FR: 'Fractionné au seuil',
    IT: 'Ripetute alla soglia',
  },
  'vo2-intervals': {
    EN: 'VO2max intervals',
    FR: 'Fractionné VMA',
    IT: 'Ripetute VO2max',
  },
  hills: { EN: 'Hill repeats', FR: 'Côtes', IT: 'Ripetute in salita' },
  fartlek: { EN: 'Fartlek', FR: 'Fartlek', IT: 'Fartlek' },
  'race-pace': {
    EN: 'Race pace session',
    FR: 'Séance allure course',
    IT: 'Sessione al ritmo gara',
  },
  race: { EN: 'RACE DAY', FR: 'JOUR DE COURSE', IT: 'GIORNO DI GARA' },
  'cross-training': {
    EN: 'Cross-training',
    FR: 'Entraînement croisé',
    IT: 'Cross-training',
  },
};

const SESSION_PURPOSE: Record<ArchetypeKey, Translations> = {
  recovery: {
    EN: 'Very easy. The point is to move blood, not to train.',
    FR: 'Très facile. Le but est de faire circuler, pas de travailler.',
    IT: 'Molto facile. Serve a far circolare il sangue, non ad allenare.',
  },
  easy: {
    EN: 'Conversational effort. This is where aerobic fitness is built.',
    FR: "Allure de conversation. C'est là que se construit l'endurance.",
    IT: 'Ritmo conversazione. Qui si costruisce la base aerobica.',
  },
  'easy-strides': {
    EN: 'Easy running finished with short accelerations to keep the legs quick.',
    FR: 'Footing terminé par des accélérations courtes pour garder du pied.',
    IT: 'Corsa facile con brevi accelerazioni per mantenere la brillantezza.',
  },
  'long-run': {
    EN: 'Time on feet. Keep it steady and comfortable throughout.',
    FR: 'Du temps de course. Restez régulier et confortable.',
    IT: 'Tempo sulle gambe. Mantenete un ritmo regolare e comodo.',
  },
  'progressive-long-run': {
    EN: 'Start easy, lift to marathon effort for the final third.',
    FR: "Départ facile, montée à l'allure marathon sur le dernier tiers.",
    IT: 'Partenza facile, ultimo terzo al ritmo maratona.',
  },
  threshold: {
    EN: 'Comfortably hard and continuous. Should feel controlled, not racing.',
    FR: "Soutenu mais contrôlé, en continu. Ce n'est pas une course.",
    IT: 'Impegnativo ma controllato, in continuo. Non è una gara.',
  },
  'cruise-intervals': {
    EN: 'Threshold work broken into blocks, with short floats between.',
    FR: 'Travail au seuil fractionné en blocs, avec récupération courte.',
    IT: 'Lavoro alla soglia diviso in blocchi, con recuperi brevi.',
  },
  'vo2-intervals': {
    EN: 'Hard intervals at 3-5k effort. Hit the pace, do not exceed it.',
    FR: "Intervalles durs à allure 3-5 km. Tenez l'allure sans la dépasser.",
    IT: 'Ripetute dure al ritmo 3-5 km. Tenete il ritmo, non superatelo.',
  },
  hills: {
    EN: 'Short hard climbs. Strength and running economy with less impact.',
    FR: "Côtes courtes et intenses. Force et économie avec moins d'impact.",
    IT: 'Salite brevi e intense. Forza ed economia con meno impatto.',
  },
  fartlek: {
    EN: 'Alternating surges and easy running. Relaxed, unstructured speed.',
    FR: "Alternance d'accélérations et de footing. De la vitesse détendue.",
    IT: 'Alternanza di allunghi e corsa facile. Velocità rilassata.',
  },
  'race-pace': {
    EN: 'Practice race effort at your current fitness. The training pace may be slower than your goal pace.',
    FR: "Travaillez l'allure course selon votre forme actuelle, parfois plus lente que votre objectif.",
    IT: 'Allenate il ritmo gara in base alla forma attuale, anche se più lento del ritmo obiettivo.',
  },
  race: {
    EN: 'The goal event. Start conservatively and trust the training.',
    FR: "L'objectif. Partez prudemment et faites confiance à la préparation.",
    IT: "L'obiettivo. Partite prudenti e fidatevi della preparazione.",
  },
  'cross-training': {
    EN: 'Low-impact aerobic work. Keeps fitness without loading the legs.',
    FR: 'Travail aérobie sans impact. Maintient la forme sans charger.',
    IT: 'Lavoro aerobico a basso impatto. Mantiene la forma senza caricare.',
  },
};

const PACE_LABEL: Record<Language, string> = {
  EN: 'Target pace',
  FR: 'Allure cible',
  IT: 'Ritmo obiettivo',
};

const CYCLE_NAMES: Record<CYCLE_PHASE, Translations> = {
  [CYCLE_PHASE.BASE]: { EN: 'Base', FR: 'Base', IT: 'Base' },
  [CYCLE_PHASE.SPECIFIC]: { EN: 'Specific', FR: 'Spécifique', IT: 'Specifico' },
  [CYCLE_PHASE.TAPER]: { EN: 'Taper', FR: 'Affûtage', IT: 'Scarico' },
  [CYCLE_PHASE.RECOVERY]: {
    EN: 'Recovery',
    FR: 'Récupération',
    IT: 'Recupero',
  },
  [CYCLE_PHASE.COMPETITION]: { EN: 'Race', FR: 'Course', IT: 'Gara' },
};

const CYCLE_DESCRIPTIONS: Record<CYCLE_PHASE, Translations> = {
  [CYCLE_PHASE.BASE]: {
    EN: 'Build aerobic volume and durability, with light quality to stay sharp.',
    FR: 'Construire le volume aérobie et la solidité, avec un peu de qualité.',
    IT: 'Costruire volume aerobico e resistenza, con poca qualità.',
  },
  [CYCLE_PHASE.SPECIFIC]: {
    EN: 'Sharpen towards the goal with race-specific intensity.',
    FR: "Affiner vers l'objectif avec une intensité spécifique.",
    IT: "Affinare verso l'obiettivo con intensità specifica.",
  },
  [CYCLE_PHASE.TAPER]: {
    EN: 'Cut volume, keep intensity. Arrive fresh, not fitter.',
    FR: "Réduire le volume, garder l'intensité. Arriver frais.",
    IT: "Ridurre il volume, mantenere l'intensità. Arrivare freschi.",
  },
  [CYCLE_PHASE.RECOVERY]: {
    EN: 'Absorb the previous block. Volume down, intensity minimal.',
    FR: 'Assimiler le bloc précédent. Volume bas, intensité minimale.',
    IT: 'Assimilare il blocco precedente. Volume basso, intensità minima.',
  },
  [CYCLE_PHASE.COMPETITION]: {
    EN: 'Race week. Everything is done; stay loose and rest.',
    FR: 'Semaine de course. Le travail est fait : restez souple et reposez-vous.',
    IT: 'Settimana di gara. Il lavoro è fatto: restate sciolti e riposate.',
  },
};

const WEEK_THEMES: Record<CYCLE_PHASE, Translations> = {
  [CYCLE_PHASE.BASE]: {
    EN: 'Aerobic base',
    FR: 'Base aérobie',
    IT: 'Base aerobica',
  },
  [CYCLE_PHASE.SPECIFIC]: {
    EN: 'Specific work',
    FR: 'Travail spécifique',
    IT: 'Lavoro specifico',
  },
  [CYCLE_PHASE.TAPER]: { EN: 'Taper', FR: 'Affûtage', IT: 'Scarico' },
  [CYCLE_PHASE.RECOVERY]: {
    EN: 'Recovery week',
    FR: 'Semaine de récupération',
    IT: 'Settimana di recupero',
  },
  [CYCLE_PHASE.COMPETITION]: {
    EN: 'Race week',
    FR: 'Semaine de course',
    IT: 'Settimana di gara',
  },
};

const PLAN_GOAL: Record<Language, (target: string) => string> = {
  EN: (target) => `Prepare for ${target}`,
  FR: (target) => `Préparer ${target}`,
  IT: (target) => `Prepararsi per ${target}`,
};

const GENERAL_FITNESS_GOAL: Translations = {
  EN: 'Build running fitness',
  FR: 'Développer sa condition physique en course',
  IT: 'Migliorare la forma nella corsa',
};

const PLAN_DESCRIPTION: Record<
  Language,
  (weeks: number, days: number) => string
> = {
  EN: (weeks, days) =>
    `A ${weeks}-week progressive plan, ${days} sessions per week, built from your current training load and adjusted as you go.`,
  FR: (weeks, days) =>
    `Un plan progressif de ${weeks} semaines, ${days} séances par semaine, construit à partir de votre charge actuelle et ajusté au fil du temps.`,
  IT: (weeks, days) =>
    `Un piano progressivo di ${weeks} settimane, ${days} sessioni a settimana, costruito sul tuo carico attuale e adattato strada facendo.`,
};

export function sessionName(
  archetype: ArchetypeKey,
  language: Language,
): string {
  return SESSION_NAMES[archetype][language];
}

export function sessionDescription(
  archetype: ArchetypeKey,
  intensity: RunIntensity,
  paces: PaceTable,
  language: Language,
  effortBased = false,
  steps?: CreateWorkoutStepDto[],
  goalPace?: number | null,
): string {
  const purpose = SESSION_PURPOSE[archetype][language];

  if (archetype === 'race' && goalPace) {
    const label = { EN: 'Goal pace', FR: 'Allure objectif', IT: 'Ritmo obiettivo' }[language];
    return `${purpose} ${label}: ${formatPace(goalPace)}.`;
  }

  if (archetype === 'cross-training' || effortBased) {
    return purpose;
  }

  if (steps) {
    const work = steps.flatMap(step => step.repeatBlock?.childSteps ?? [step])
      .filter(step => step.stepType === WORKOUT_STEP_TYPE.STEADY || step.stepType === WORKOUT_STEP_TYPE.INTERVAL_ACTIVE);
    const step = archetype === 'progressive-long-run' ? work[work.length - 1] : work[0];
    const target = step?.targets?.find(target => target.targetType === WORKOUT_TARGET_TYPE.PACE);
    // Zone- and effort-based workouts must not advertise an unrelated pace.
    if (!target) return purpose;
    const speed = target.targetValue ?? (target.targetMin != null && target.targetMax != null ? (target.targetMin + target.targetMax) / 2 : null);
    return speed ? `${purpose} ${PACE_LABEL[language]}: ${formatPace(speed)}.` : purpose;
  }
  return `${purpose} ${PACE_LABEL[language]}: ${formatPace(paces[intensity])}.`;
}

export function cycleName(phase: CYCLE_PHASE, language: Language): string {
  return CYCLE_NAMES[phase][language];
}

export function cycleDescription(
  phase: CYCLE_PHASE,
  language: Language,
): string {
  return CYCLE_DESCRIPTIONS[phase][language];
}

export function weekTheme(week: WeekSkeleton, language: Language): string {
  const phase = week.isRecovery ? CYCLE_PHASE.RECOVERY : week.phase;
  return WEEK_THEMES[phase][language];
}

export function planGoal(
  targetLabel: string | null,
  language: Language,
): string {
  return targetLabel === null
    ? GENERAL_FITNESS_GOAL[language]
    : PLAN_GOAL[language](targetLabel);
}

export function planDescription(
  weeks: number,
  daysPerWeek: number,
  language: Language,
): string {
  return PLAN_DESCRIPTION[language](weeks, daysPerWeek);
}

/** Colors used for cycle blocks in the calendar and plan overview. */
export const CYCLE_COLORS: Record<CYCLE_PHASE, string> = {
  [CYCLE_PHASE.BASE]: '#3B82F6',
  [CYCLE_PHASE.SPECIFIC]: '#F59E0B',
  [CYCLE_PHASE.TAPER]: '#10B981',
  [CYCLE_PHASE.RECOVERY]: '#6B7280',
  [CYCLE_PHASE.COMPETITION]: '#EF4444',
};
