import {
  formatPace,
  paceTableForVdot,
  percentVo2maxForDuration,
  predictRaceTime,
  resolveFitness,
  riegelEquivalentTime,
  vdotFromPerformance,
  velocityForVo2,
  vo2AtVelocity,
} from './physiology';
import { RunIntensity } from './types';

describe('physiology', () => {
  describe('Daniels/Gilbert equations', () => {
    it('inverts the oxygen cost equation', () => {
      for (const velocity of [150, 200, 250, 320, 400]) {
        const vo2 = vo2AtVelocity(velocity);
        expect(velocityForVo2(vo2)).toBeCloseTo(velocity, 6);
      }
    });

    it('sustains a smaller fraction of VO2max as the effort lengthens', () => {
      const short = percentVo2maxForDuration(10);
      const medium = percentVo2maxForDuration(60);
      const long = percentVo2maxForDuration(180);

      expect(short).toBeGreaterThan(medium);
      expect(medium).toBeGreaterThan(long);
      // A 3 hour effort sits a little above 80% of VO2max.
      expect(long).toBeGreaterThan(0.8);
      expect(long).toBeLessThan(0.85);
    });

    it('derives a plausible VDOT from a known performance', () => {
      // A 20:00 5k is a canonical VDOT 50 performance in Daniels' tables.
      const vdot = vdotFromPerformance(5000, 20 * 60);

      expect(vdot).toBeGreaterThan(48);
      expect(vdot).toBeLessThan(52);
    });

    it('round-trips VDOT through a race time prediction', () => {
      const vdot = vdotFromPerformance(10000, 42 * 60);
      const predicted = predictRaceTime(vdot, 10000);

      expect(predicted).toBeCloseTo(42 * 60, 0);
    });

    it('predicts slower paces over longer distances', () => {
      const vdot = vdotFromPerformance(5000, 20 * 60);

      const fiveKPace = predictRaceTime(vdot, 5000) / 5;
      const marathonPace = predictRaceTime(vdot, 42195) / 42.195;

      expect(marathonPace).toBeGreaterThan(fiveKPace);
    });
  });

  describe('riegelEquivalentTime', () => {
    it('scales a 10k time up to a marathon', () => {
      const marathon = riegelEquivalentTime(10000, 45 * 60, 42195);

      // Riegel puts a 45:00 10k runner around 3h30 for the marathon.
      expect(marathon).toBeGreaterThan(3.3 * 3600);
      expect(marathon).toBeLessThan(3.7 * 3600);
    });
  });

  describe('paceTableForVdot', () => {
    const paces = paceTableForVdot(50);

    it('orders intensities from slowest to fastest', () => {
      expect(paces[RunIntensity.RECOVERY]).toBeLessThan(
        paces[RunIntensity.EASY],
      );
      expect(paces[RunIntensity.EASY]).toBeLessThan(
        paces[RunIntensity.MARATHON],
      );
      expect(paces[RunIntensity.MARATHON]).toBeLessThan(
        paces[RunIntensity.THRESHOLD],
      );
      expect(paces[RunIntensity.THRESHOLD]).toBeLessThan(
        paces[RunIntensity.INTERVAL],
      );
      expect(paces[RunIntensity.INTERVAL]).toBeLessThan(
        paces[RunIntensity.REPETITION],
      );
    });

    it('sets threshold pace to what the athlete could race for an hour', () => {
      // T pace is defined as one-hour race pace, so racing at threshold should
      // take an hour by the model's own prediction.
      const distance = paces[RunIntensity.THRESHOLD] * 3600;

      expect(predictRaceTime(50, distance) / 60).toBeCloseTo(60, 0);
    });

    it('sets marathon pace to actual predicted marathon pace', () => {
      const predicted = predictRaceTime(50, 42195);

      expect(paces[RunIntensity.MARATHON]).toBeCloseTo(42195 / predicted, 6);
    });

    it('keeps easy pace in the conversational band', () => {
      const easySecondsPerKm = 1000 / paces[RunIntensity.EASY];

      expect(easySecondsPerKm).toBeGreaterThan(5 * 60);
      expect(easySecondsPerKm).toBeLessThan(6 * 60);
    });

    it('does not prescribe marathon pace a slow runner cannot hold', () => {
      // The failure mode of a fixed "marathon = 84% of VO2max" constant: a
      // four-hour marathoner gets prescribed a pace they cannot sustain for
      // four hours. Marathon pace must always be slower than threshold.
      for (const vdot of [30, 35, 40, 50, 60, 70]) {
        const table = paceTableForVdot(vdot);

        expect(table[RunIntensity.MARATHON]).toBeLessThan(
          table[RunIntensity.THRESHOLD],
        );
        expect(table[RunIntensity.MARATHON]).toBeGreaterThan(
          table[RunIntensity.EASY],
        );
      }
    });

    it('formats a pace as minutes per kilometre', () => {
      expect(formatPace(1000 / 255)).toBe('4:15/km');
      expect(formatPace(5)).toBe('3:20/km');
    });
  });

  describe('resolveFitness', () => {
    it('prefers a real performance over device metrics', () => {
      const resolved = resolveFitness({
        vmaKmh: 14,
        bestEfforts: [{ distanceMeters: 10000, timeSeconds: 40 * 60 }],
      });

      expect(resolved.source).toBe('BEST_EFFORT');
      expect(resolved.currentVdot).toBeGreaterThan(45);
    });

    it('ignores sprint efforts that are poor VDOT estimators', () => {
      const resolved = resolveFitness({
        vmaKmh: 15,
        bestEfforts: [{ distanceMeters: 400, timeSeconds: 60 }],
      });

      expect(resolved.source).toBe('VMA_METRIC');
    });

    it('falls back through metrics then population defaults', () => {
      expect(resolveFitness({ vo2max: 55 }).source).toBe('VO2MAX_METRIC');
      expect(resolveFitness({ vmaKmh: 16 }).source).toBe('VMA_METRIC');
      expect(resolveFitness({}).source).toBe('DEFAULT');
    });

    it('trains off a fraction of the goal when nothing else is known', () => {
      const resolved = resolveFitness(
        {},
        { distanceMeters: 42195, timeSeconds: 3.5 * 3600 },
      );

      expect(resolved.source).toBe('GOAL_TIME');
      expect(resolved.goalVdot).not.toBeNull();
      expect(resolved.currentVdot).toBeLessThan(resolved.goalVdot as number);
    });

    it('uses population defaults for missing heart rate data', () => {
      const resolved = resolveFitness({});

      expect(resolved.hrMax).toBe(190);
      expect(resolved.hrRest).toBe(60);
      expect(resolved.gender).toBe('male');
    });
  });
});
