import { describe, it, expect } from 'vitest';
import { runOnLanes } from '../src/lanePool.js';
import { deferred, settleMicrotasks, type Deferred } from './support.js';

/** Jobs the test finishes by hand; records which lane started which job. */
function heldJobs() {
  const started: string[] = [];
  const held: Array<Deferred<void>> = [];
  const job = (index: number, lane: string): Promise<void> => {
    started.push(`${index}@${lane}`);
    const done = deferred();
    held.push(done);
    return done.promise;
  };
  return { started, held, job };
}

describe('runOnLanes', () => {
  it('starts one job per free lane and the next job on whichever lane frees up', async () => {
    const jobs = heldJobs();
    const all = runOnLanes(3, ['L1', 'L2'], jobs.job);
    await settleMicrotasks();
    expect(jobs.started).toEqual(['0@L1', '1@L2']);
    jobs.held[1]!.resolve();
    await settleMicrotasks();
    expect(jobs.started).toEqual(['0@L1', '1@L2', '2@L2']);
    jobs.held[0]!.resolve();
    jobs.held[2]!.resolve();
    await all;
  });

  it('starts no job once told to stop, but finishes those under way', async () => {
    const jobs = heldJobs();
    let stop = false;
    const all = runOnLanes(10, ['L1', 'L2'], jobs.job, () => stop);
    await settleMicrotasks();
    stop = true;
    jobs.held[0]!.resolve();
    jobs.held[1]!.resolve();
    await all;
    expect(jobs.started).toEqual(['0@L1', '1@L2']);
  });

  it('rejects with the first error once the jobs under way finish', async () => {
    let finished = false;
    const all = runOnLanes(5, ['L1', 'L2'], async (index) => {
      if (index === 0) throw new Error('lane broke');
      await settleMicrotasks();
      finished = true;
    });
    await expect(all).rejects.toThrow('lane broke');
    expect(finished).toBe(true);
  });

  it('resolves at once with no jobs and refuses to run without lanes', async () => {
    await runOnLanes(0, ['L1'], async () => {
      throw new Error('never');
    });
    await expect(runOnLanes(1, [], async () => {})).rejects.toThrow(/no lanes/);
  });
});
