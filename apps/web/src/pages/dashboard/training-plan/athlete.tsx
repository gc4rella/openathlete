import { m } from '@/paraglide/messages';
import { TrainingPlanView } from '@/views/dashboard/training-plan-view';
import { useParams } from 'react-router-dom';

/**
 * A coach viewing one of their athletes' plans.
 */
export function AthleteTrainingPlanPage() {
  const { athleteId } = useParams();

  return (
    <>
      <title>{m.training_plan()}</title>
      <TrainingPlanView athleteId={Number(athleteId)} />
    </>
  );
}
