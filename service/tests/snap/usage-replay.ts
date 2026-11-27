import type { JourneyEvent, UsageObservation } from "../../../shared/usage";
import { loadFixture, readRecording, recordingPath, replay, type Backend } from "./harness";

export async function replayWithUsage(
  backend: Backend,
  name: string,
  modify?: (recording: ReturnType<typeof readRecording>) => void,
  dataDir?: string,
) {
  const rec = readRecording(recordingPath(backend, name));
  modify?.(rec);
  const usage: UsageObservation[] = [];
  const journey: JourneyEvent[] = [];
  const result = await replay(
    backend,
    rec,
    await loadFixture(backend, name),
    undefined,
    {
      recordUsage: (row) => usage.push(row),
      recordJourney: (row) => journey.push(row),
    },
    dataDir,
  );
  return { rec, result, usage, journey };
}
