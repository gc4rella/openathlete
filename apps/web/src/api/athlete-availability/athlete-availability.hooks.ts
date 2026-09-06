import {
  MutationOptions,
  QueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { AthleteAvailabilityAPI } from './athlete-availability.api';
import { athleteAvailabilityKeys } from './athlete-availability.keys';

export const useAthleteAvailabilityQuery = (
  athleteId?: number,
  opt?: QueryOptions<Awaited<ReturnType<typeof AthleteAvailabilityAPI.get>>>,
) =>
  useQuery({
    ...opt,
    queryKey: [athleteAvailabilityKeys.get, athleteId],
    queryFn: () => AthleteAvailabilityAPI.get(athleteId),
  });

export const useSetAthleteAvailabilityMutation = (
  opt?: MutationOptions<
    Awaited<ReturnType<typeof AthleteAvailabilityAPI.set>>,
    Error,
    Parameters<typeof AthleteAvailabilityAPI.set>[0]
  >,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    ...opt,
    mutationFn: AthleteAvailabilityAPI.set,
    onSuccess: (data, variables, onMutateResult, context) => {
      if (opt?.onSuccess) {
        opt.onSuccess(data, variables, onMutateResult, context);
      }
      queryClient.invalidateQueries({
        queryKey: [athleteAvailabilityKeys.get],
      });
    },
  });
};
