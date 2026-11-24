import { expect } from "vitest";
import { captures } from "../pi-captures.ts";
import { agentMessages, fixture } from "../fixture.ts";

export default fixture({
  ...captures["basic-turn"],
  verify(r) {
    const thinking = r.events.filter((e) => e.kind === "thinking_delta");
    expect(thinking[0]).toMatchObject({ content: "", startedAt: expect.any(Number) as unknown });
    expect(thinking.at(-1)).toMatchObject({ content: "", durationMs: 2630, thinkingFollows: true });
    expect(agentMessages(r)[0]).toMatchObject({
      status: "done",
      content: "xxxxx",
      context: { tokens: 412, window: 272000 },
    });
    expect(r.sessions[0].usage).toMatchObject({ input_tokens: 412, output_tokens: 37, turns: 1 });
    expect(r.pi!.checkpoints.stats.contextUsage).toMatchObject({
      totalTokens: 449,
      maxTokens: 272000,
      model: "openai-codex/gpt-6.2-astra",
    });
  },
});
