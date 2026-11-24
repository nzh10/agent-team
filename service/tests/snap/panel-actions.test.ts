// The calls the client shows as lines of their own are the calls whose text
// summary pages keep: one list on each side, the same.
import { it, expect } from "vitest";
import { PANEL_ACTIONS as server } from "../../../shared/panel-actions";
import { PANEL_ACTIONS as client } from "../../../webview/src/chat/events";

it("server and client agree on the panel's actions", () => {
  expect([...server].sort()).toEqual([...client].sort());
});
