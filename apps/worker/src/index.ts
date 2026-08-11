/**
 * Background jobs.
 *
 * Runs as a separate process from the API because these are long, periodic, and
 * must not compete with request latency. On the droplet this is a second
 * systemd unit pointed at the same database.
 *
 * Currently registers one job and does nothing useful -- the summariser it
 * calls is a skeleton. It exists now so that when memory summarisation becomes
 * real there is somewhere obvious to put it.
 */

const MINUTE = 60_000;

interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<void>;
}

const jobs: Job[] = [
  {
    name: 'memory-summarization',
    // Hourly is a guess. The right cadence depends on how fast episodic memory
    // actually accumulates, which you will not know until real students use it.
    intervalMs: 60 * MINUTE,
    async run() {
      // TODO(memory): for each agent with unsummarised entries older than the
      // retention window, call summarizeAgentMemory from @studentos/agent.
      //
      // Two things to get right when implementing:
      //   - Bill each summarisation to the agent's OWNER, not a shared key.
      //     See the note in packages/agent/src/memory/summarize.ts.
      //   - Iterate agents in batches. A single query returning every agent
      //     works until it very suddenly does not.
    },
  },
];

async function runJob(job: Job): Promise<void> {
  try {
    await job.run();
  } catch (error) {
    // Never let one job's failure kill the process -- the others still need
    // to run, and a crash loop on the droplet is silent until someone looks.
    console.error(`Job "${job.name}" failed`, error);
  }
}

function start(): void {
  console.log(`Worker started with ${jobs.length} job(s)`);

  for (const job of jobs) {
    void runJob(job);
    setInterval(() => void runJob(job), job.intervalMs);
  }
}

start();
