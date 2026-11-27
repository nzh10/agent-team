import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { readNote, writeNote } from "../../src/project/notes";
import { ObjectiveStore } from "../../src/project/objectives";
import { ProjectStore } from "../../src/project/store";
import { loadAll, saveIndex, saveWorkspace } from "../../src/workspace/state";
import { runDemoJourney } from "./demo-journey-harness";

const pageOptions = { viewport: { width: 1280, height: 800 }, timeout: 10_000 };
const visible = (locator: Locator) => locator.waitFor({ state: "visible" });
const hidden = (locator: Locator) => locator.waitFor({ state: "hidden" });
const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });
const chat = (page: Page, text: string) => visible(page.locator(".messages", { hasText: text }));

it("filters the real board, follows dependency and issue links, and reopens a note after a live disk edit", async () => {
  await runDemoJourney(
    "yaat-board-projects-",
    pageOptions,
    async (page, { origin, dir, seed }) => {
      await page.goto(`${origin}/#chat-anchor`);
      await page.locator(".ws-group-project .ws-group-label", { hasText: "agent-team" }).click();
      await chat(page, "分成两件事");
      const chatUrl = page.url();
      const openBoard = () => button(page, "Objectives of agent-team").click();
      await openBoard();
      expect(page.url()).toBe(chatUrl);
      const board = page.getByRole("dialog");
      const cards = board.locator(".bp-card");
      const card = (title: string) => cards.filter({ hasText: title });
      await visible(card("Panels on phones"));
      await visible(card("Low priority follow-up"));
      await visible(board.getByText("ui/unreadable.toml"));
      await hidden(card("Native Windows server"));
      const titles = await board.locator(".bp-card-title").allTextContents();
      expect(titles.indexOf("Panels on phones")).toBeLessThan(
        titles.indexOf("Low priority follow-up"),
      );
      const statuses = board.getByRole("group", { name: "Status" });
      await hidden(button(statuses, /^Archive\b/));
      await visible(button(board, /^All areas/).getByText("5", { exact: true }));
      expect(await cards.count()).toBe(5);
      const ui = button(board.getByRole("navigation", { name: "Filters" }), /^ui/);
      await visible(ui.getByText("4", { exact: true }));
      await ui.click();
      expect(await cards.count()).toBe(4);
      await visible(card("Panels on phones"));
      await hidden(card("Preview deploys per branch"));
      await button(board, /^All areas\b/).click();
      const search = board.getByPlaceholder("Search objectives…");
      await search.fill("panels");
      await visible(card("Panels that use a big screen"));
      await hidden(card("Preview deploys per branch"));
      await search.fill("no such objective");
      await visible(board.getByText("Nothing matches."));
      await search.press("Escape");
      expect(await search.inputValue()).toBe("");
      await search.press("Escape");
      await hidden(board);
      await openBoard();
      const infra = card("Preview deploys per branch");
      await button(statuses, /^Dropped\b/).click();
      await visible(card("Native Windows server"));
      await visible(card("Native Windows server").getByText(/WSL works well/));
      await infra.click();
      const detail = (name: string) => board.getByRole("complementary", { name, exact: true });
      await visible(detail("Preview deploys per branch").getByText("low priority"));
      await visible(detail("Preview deploys per branch").getByTitle("Not an objective"));
      await page.keyboard.press("Escape");
      await hidden(detail("Preview deploys per branch"));

      await button(board, "Dependencies").click();
      await board.locator(".bp-node", { hasText: "Preview deploys per branch" }).click();
      await button(detail("Preview deploys per branch"), /Panels on phones/).click();
      const mobile = detail("Panels on phones");
      await visible(mobile);
      await button(mobile, "Close details").click();

      const issuesMode = button(board.getByRole("group", { name: "Show" }), /^Issues/);
      await visible(issuesMode.getByText("2", { exact: true }));
      await issuesMode.click();
      await visible(board.getByText("1 open · 1 to decide · 1 accepted"));
      const row = (id: string) => board.locator(".bi-row", { hasText: id });
      await visible(row("04-12#1").getByText("touch", { exact: true }));
      await visible(row("04-12#2").getByText("To decide", { exact: true }));
      await hidden(row("04-11#1"));
      await visible(
        board.getByRole("group", { name: "Evidence" }).getByTitle("Reproduced by a script"),
      );
      const issueStates = board.getByRole("group", { name: "State" });
      await button(issueStates, /^Accepted\b/).click();
      await visible(row("04-11#1"));
      await board.getByTitle("ui: Mobile & Panel UI", { exact: true }).click();
      await visible(board.getByText("Sheet header & resize edge", { exact: true }));
      await visible(board.locator("main").getByText(/^Shared by/));
      await hidden(row("04-11#1"));
      await button(issueStates, /^To decide\b/).click();
      await visible(row("04-12#1"));
      await hidden(row("04-12#2"));
      await button(issueStates, /^To decide\b/).click();
      await button(board.getByRole("group", { name: "Tags" }), /^gesture\b/).click();
      await visible(row("04-12#2"));
      await hidden(row("04-12#1"));
      await button(board.getByRole("group", { name: "Tags" }), /^gesture\b/).click();
      const issueSearch = board.getByPlaceholder("Search issues…");
      await issueSearch.fill("VERTICAL SCROLLING");
      await visible(row("04-12#2"));
      await hidden(row("04-12#1"));
      await issueSearch.press("Escape");
      expect(await issueSearch.inputValue()).toBe("");
      await button(board.getByRole("group", { name: "Evidence" }), /^V/).click();
      await visible(row("04-12#2"));
      await hidden(row("04-12#1"));
      await row("04-12#2").click();
      const issue = detail("Issue 04-12#2");
      await visible(issue.getByText(/Shared by/));
      await visible(issue.getByText("To decide", { exact: true }));
      await visible(issue.getByText(/Touch-target and responsive layout/));
      await button(issue, /Panels on phones/).click();
      await visible(mobile);

      const requestedArchivePaths: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        const path = url.searchParams.get("path");
        if (url.pathname === "/api/file" && path?.startsWith("notes/_archive")) {
          requestedArchivePaths.push(path);
        }
      });
      await button(board, /^Notes\b/).click();
      const tree = board.getByRole("tree", { name: "Notes" });
      const archiveFolder = tree.getByRole("treeitem", { name: "_archive", exact: true });
      const oldNote = tree.getByRole("treeitem", { name: "old-guide.md" });
      await visible(tree.getByRole("treeitem", { name: "checklist.md" }));
      await visible(archiveFolder);
      expect(await archiveFolder.getAttribute("aria-expanded")).toBe("false");
      await hidden(oldNote);
      expect(requestedArchivePaths).toEqual([]);
      await archiveFolder.click();
      await oldNote.click();
      await visible(board.getByRole("heading", { name: "Old guide" }));
      await board.getByText("project architecture", { exact: true }).click();
      await visible(board.getByRole("heading", { name: "Architecture Notes" }));
      expect(
        await tree.getByRole("treeitem", { name: "architecture.md" }).getAttribute("aria-selected"),
      ).toBe("true");
      await tree.getByRole("treeitem", { name: "mobile-spec.md" }).click();
      await visible(board.getByRole("heading", { name: "Mobile Panels Spec" }));
      const notes = new ProjectStore(dir).notesDir(seed.projectId);
      const original = readNote(notes, "mobile-spec");
      const marker = "Updated on disk while the board was open.";
      writeNote(notes, "mobile-spec", `${original.content}\n${marker}\n`, original.version);
      await button(board, "Close the file").click();
      await tree.getByRole("treeitem", { name: "mobile-spec.md" }).click();
      await visible(board.getByText(marker, { exact: true }));
      await button(board, "Close the file").click();
      await page.keyboard.press("Escape");
      await hidden(board);
      await chat(page, "分成两件事");
      expect(page.url()).toBe(chatUrl);
      expect(new URL(page.url()).hash).toBe("#chat-anchor");

      await openBoard();
      await card("Panels on phones").click();
      await button(mobile, "mobile panels").first().click();
      await hidden(board);
      await chat(page, "sheet 头部已经改好");
      await openBoard();
      await visible(board);
      await button(board, "Close").click();
      await chat(page, "sheet 头部已经改好");
      expect(page.url()).toBe(chatUrl);
      await page.getByTitle("Open the lead of Empty board", { exact: true }).click();
      await button(page, "Objectives of Empty board").click();
      const empty = page.getByRole("dialog");
      await visible(empty.getByText(/No objectives yet/));
      await button(empty, "Issues").click();
      await visible(empty.getByText(/No issues yet/));
      await button(empty, "Notes").click();
      await visible(empty.getByText("No notes yet."));
    },
    (dir, seed) => {
      const projects = new ProjectStore(dir);
      const objectiveDir = projects.objectivesDir(seed.projectId);
      const objectives = new ObjectiveStore(objectiveDir);
      const mobile = objectives.get("ui/mobile-panels")!;
      objectives.write({
        ...mobile,
        id: "ui/follow-up",
        title: "Low priority follow-up",
        priority: "low",
      });
      const preview = objectives.get("infra/deploy-preview")!;
      objectives.write({ ...preview, dependsOn: [...preview.dependsOn, "infra/missing"] });
      writeFileSync(join(objectiveDir, "ui", "unreadable.toml"), "[bad TOML");
      const notes = projects.notesDir(seed.projectId);
      const release = join(notes, "release");
      mkdirSync(release);
      writeFileSync(join(release, "checklist.md"), "# Release checklist\n");
      const archive = join(notes, "_archive");
      mkdirSync(archive);
      writeFileSync(
        join(archive, "old-guide.md"),
        "# Old guide\n\nSee [project architecture](../architecture.md).\n",
      );
      const workspaces = loadAll(dir);
      const template = workspaces.find((ws) => ws.id === seed.workspaces.lead)!;
      const empty = projects.create("Empty board", seed.repo);
      const id = "ws-empty-board";
      empty.lead = { hostId: template.hostId, workspaceId: id };
      projects.save(empty);
      saveWorkspace(dir, {
        ...template,
        id,
        name: "Empty board lead",
        agents: [],
        messages: [],
        projectLink: { projectId: empty.id, role: "lead" },
      });
      saveIndex(dir, [...workspaces.map((ws) => ws.id), id]);
    },
  );
}, 90_000);

it("uses real sidebar groups, archives, history search, confirmations, and debug gating", async () => {
  await runDemoJourney(
    "yaat-board-projects-",
    pageOptions,
    async (page, { origin, dir, seed }) => {
      await page.addInitScript((id) => {
        if (!localStorage.getItem("activeWsId")) localStorage.setItem("activeWsId", id);
      }, seed.workspaces.lead);
      const report = page.waitForResponse(`${origin}/api/diagnostics`);
      await page.goto(origin);
      const group = page.locator(".ws-group:has(> .ws-group-project)", { hasText: "agent-team" });
      const lead = group.locator(".ws-group-label", { hasText: "agent-team" });
      const worker = group.locator(".task-item", { hasText: "mobile panels" });
      await visible(worker.getByText("Your turn"));
      await hidden(worker.getByText("Unread result"));
      expect(await group.locator(".task-item", { hasText: "agent-team · lead" }).count()).toBe(0);
      await lead.click();
      await chat(page, "分成两件事");
      await button(group, "Fold agent-team").click();
      await hidden(worker);
      await chat(page, "分成两件事");
      await button(group, "Unfold agent-team").click();
      await worker.click();
      await chat(page, "sheet 头部已经改好");
      await visible(worker.getByText("Your turn"));
      await hidden(worker.getByText("Unread result"));
      const health = (await (await report).json()) as { issues: { severity?: string }[] };
      const unhealthy = health.issues.some((issue) => issue.severity !== "info");
      const collapsedTrigger = page.getByRole("button", {
        name: unhealthy ? "Debug tools (service diagnostics unhealthy)" : "Debug tools",
        exact: true,
      });
      const expandedTrigger = page.getByRole("button", { name: "Debug tools", exact: true });
      const stripDiagnostics = page.getByRole("link", {
        name: unhealthy ? "Service diagnostics (unhealthy)" : "Service diagnostics",
        exact: true,
      });
      const snapshot = page.getByRole("button", { name: "Capture debug snapshot", exact: true });
      const replay = page.getByRole("button", { name: "Replay demo", exact: true });
      // No bottom-left fallback link; Diagnostics lives only in the debug toolbar.
      expect(await page.getByRole("link", { name: /Service diagnostics/ }).count()).toBe(0);
      expect(await page.getByRole("link", { name: "JSON", exact: true }).count()).toBe(0);
      await visible(collapsedTrigger);
      expect(await collapsedTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(await collapsedTrigger.getAttribute("aria-pressed")).toBe("false");
      expect(await page.locator(".sidebar-debug-dot").count()).toBe(unhealthy ? 1 : 0);
      await hidden(stripDiagnostics);
      await hidden(snapshot);
      await hidden(replay);

      await group.locator(".ws-archive-toggle").click();
      await group.locator(".task-item-archived", { hasText: "file routes" }).click();
      await button(page, "Restore").click();
      const routes = group.locator(".task-item", { hasText: "file routes" });
      await visible(routes);
      const search = page.locator(".search-bar input");
      await search.fill("TemplateResolver");
      const hit = page.locator(".search-result-item", { hasText: "parser crash" }).first();
      await visible(hit);
      await page.locator(".search-clear").click();
      expect(await search.inputValue()).toBe("");
      await hidden(hit);
      await visible(group);

      await routes.hover();
      const removeSession = routes.getByTitle("Delete session", { exact: true });
      await removeSession.click();
      const sessionDialog = page.getByRole("dialog", { name: "Delete file routes?" });
      await button(sessionDialog, "Cancel").click();
      await hidden(sessionDialog);
      await visible(routes);
      await routes.hover();
      await removeSession.click();
      await button(sessionDialog, "Delete session").click();
      await hidden(routes);
      await expect
        .poll(() => loadAll(dir).some((ws) => ws.id === seed.workspaces.routes))
        .toBe(false);

      await lead.click();
      await chat(page, "分成两件事");
      await button(page, "Objectives of agent-team").click();
      const board = page.getByRole("dialog", { name: "agent-team objectives" });
      const projectDialog = page.getByRole("dialog", { name: "Delete project agent-team" });
      await hidden(button(board.locator("header"), "Delete project"));
      await button(board.getByRole("navigation", { name: "Filters" }), "Delete project").click();
      await visible(projectDialog);
      await page.keyboard.press("Escape");
      await hidden(projectDialog);
      await visible(board);
      await button(board, "Archive project").click();
      const shelf = page.locator(".ws-shelf");
      await visible(shelf.getByText("Archived projects"));
      await button(board, "Close").click();
      const archived = shelf.locator(".ws-group-project", { hasText: "agent-team" });
      const shelfToggle = shelf.getByText("Archived projects");
      await visible(archived);
      const otherLead = page.getByTitle("Open the lead of Other project", { exact: true });
      await otherLead.click();
      await hidden(archived);
      await shelfToggle.click();
      await visible(archived);
      await shelfToggle.click();
      await hidden(archived);
      await shelfToggle.click();
      await archived.locator(".ws-group-label").click();
      await chat(page, "分成两件事");
      await button(archived, "Restore").click();
      await hidden(shelf);
      await visible(lead);
      await visible(group.locator(".ws-archive-toggle"));
      await lead.hover();
      const removeProject = group.getByTitle("Delete project", { exact: true });
      await removeProject.click();
      await page.keyboard.press("Escape");
      await hidden(projectDialog);
      await visible(lead);
      await lead.hover();
      await removeProject.click();
      await button(projectDialog, "Delete project").click();
      await hidden(group);
      expect(new ProjectStore(dir).get(seed.projectId)).toBeUndefined();

      const debugHealthReport = page.waitForResponse(`${origin}/api/diagnostics`);
      const snapshotUploads: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url() === `${origin}/debug/snapshot`)
          snapshotUploads.push(request.url());
      });
      await page.goto(`${origin}/?debug=1`);
      await visible(otherLead);
      const debugHealth = (await (await debugHealthReport).json()) as {
        issues: { severity?: string }[];
      };
      const debugUnhealthy = debugHealth.issues.some((issue) => issue.severity !== "info");
      const debugCollapsedTrigger = page.getByRole("button", {
        name: debugUnhealthy ? "Debug tools (service diagnostics unhealthy)" : "Debug tools",
        exact: true,
      });
      const debugStripDiagnostics = page.getByRole("link", {
        name: debugUnhealthy ? "Service diagnostics (unhealthy)" : "Service diagnostics",
        exact: true,
      });
      expect(await expandedTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(await expandedTrigger.getAttribute("aria-pressed")).toBe("true");
      await visible(debugStripDiagnostics);
      expect(await page.getByRole("link", { name: /Service diagnostics/ }).count()).toBe(1);
      expect(await debugStripDiagnostics.getAttribute("href")).toBe("api/diagnostics?format=text");
      expect(await page.getByRole("link", { name: "JSON", exact: true }).count()).toBe(0);
      expect(await page.locator(".sidebar-debug-dot").count()).toBe(debugUnhealthy ? 1 : 0);
      expect(await expandedTrigger.locator(".sidebar-debug-dot").count()).toBe(0);
      expect(await debugStripDiagnostics.locator(".sidebar-debug-dot").count()).toBe(
        debugUnhealthy ? 1 : 0,
      );
      await visible(snapshot);
      await visible(replay);
      // Clicking outside keeps the debug strip open; toggling # does not auto-capture.
      await otherLead.click();
      await visible(debugStripDiagnostics);
      await expandedTrigger.click();
      await hidden(debugStripDiagnostics);
      expect(await debugCollapsedTrigger.locator(".sidebar-debug-dot").count()).toBe(
        debugUnhealthy ? 1 : 0,
      );
      await debugCollapsedTrigger.click();
      await visible(debugStripDiagnostics);
      expect(snapshotUploads).toEqual([]);
    },
    (dir, seed) => {
      const workspaces = loadAll(dir);
      const mobile = workspaces.find((ws) => ws.id === seed.workspaces.mobile)!;
      saveWorkspace(dir, {
        ...mobile,
        attention: { unread: 3, lastResult: "done", awaitsUser: true },
      });
      const readme = workspaces.find((ws) => ws.id === seed.workspaces.solo)!;
      const projects = new ProjectStore(dir);
      const other = projects.create("Other project", readme.cwd);
      other.lead = { hostId: readme.hostId, workspaceId: readme.id };
      projects.save(other);
      saveWorkspace(dir, { ...readme, projectLink: { projectId: other.id, role: "lead" } });
    },
  );
}, 90_000);
