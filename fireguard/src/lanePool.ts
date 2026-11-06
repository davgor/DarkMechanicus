/**
 * Hands out job indexes `0..count-1` to lanes: each lane takes the next index as soon as it is
 * free, so a lane never runs two jobs at once. No lane starts another job once `stop()` returns
 * true or a job has thrown; the first error is rethrown once every lane has finished its job in
 * flight (so its workspace is no longer in use).
 */
export async function runOnLanes<L>(
  count: number,
  lanes: L[],
  run: (index: number, lane: L) => Promise<void>,
  stop: () => boolean = () => false
): Promise<void> {
  if (lanes.length === 0) throw new Error('fireguard: no lanes to run tests on');
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    lanes.map(async (lane) => {
      while (failure === undefined && next < count && !stop()) {
        const index = next;
        next += 1;
        try {
          await run(index, lane);
        } catch (error) {
          failure ??= { error };
        }
      }
    })
  );
  if (failure !== undefined) throw failure.error;
}
