/**
 * A per-instance LlamaCpp knows about the sessions opened on it, so its idle
 * timer cannot unload models under a running search. Before this, the timer
 * consulted only the default singleton's session manager.
 */
import { describe, test, expect } from "vitest";
import { LlamaCpp, withLLMSessionForLlm, canUnloadLLM } from "../src/llm.ts";

describe("per-instance session accounting", () => {
  test("a session on a store's own instance blocks its unload until released", async () => {
    const llm = new LlamaCpp({ inactivityTimeoutMs: 0 });
    expect(llm.canUnloadNow()).toBe(true);
    let inside: boolean | null = null;
    let outer: boolean | null = null;
    await withLLMSessionForLlm(llm, async (session) => {
      inside = llm.canUnloadNow();
      // The default singleton's manager knows nothing about this session.
      outer = canUnloadLLM();
      expect(session.isValid).toBe(true);
    });
    expect(inside).toBe(false);
    expect(outer).toBe(true);
    expect(llm.canUnloadNow()).toBe(true);
    await llm.dispose();
  });

  test("nested sessions are counted, and a throwing callback still releases", async () => {
    const llm = new LlamaCpp({ inactivityTimeoutMs: 0 });
    await withLLMSessionForLlm(llm, async () => {
      await withLLMSessionForLlm(llm, async () => {
        expect(llm.canUnloadNow()).toBe(false);
      });
      expect(llm.canUnloadNow()).toBe(false);
    });
    expect(llm.canUnloadNow()).toBe(true);
    await expect(withLLMSessionForLlm(llm, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(llm.canUnloadNow()).toBe(true);
    await llm.dispose();
  });
});
