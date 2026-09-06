import { useGetMyAthleteQuery } from '@/api/athlete';
import { LoadingScreen } from '@/components/loading-screen';
import { m } from '@/paraglide/messages';
import { TrainingPlanView } from '@/views/dashboard/training-plan-view';

export function TrainingPlanPage() {
  const { data: athlete } = useGetMyAthleteQuery();

  if (!athlete) {
    return <LoadingScreen />;
  }

  return (
    <>
      <title>{m.training_plan()}</title>
      <TrainingPlanView athleteId={athlete.athleteId} />
    </>
  );
}
