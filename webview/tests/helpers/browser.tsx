import { fireEvent, render } from "@testing-library/react";
import { page } from "vitest/browser";
import { App } from "../../src/App";

// Test App in the production scroll host rather than the browser runner's body.
export function mountFixedApp() {
  const root = document.createElement("div");
  root.id = "root";
  root.style.cssText = "position:fixed; inset:0; height:100dvh";
  document.body.append(root);
  return render(<App />, { container: root });
}

export async function themedViewport(width: number, height: number, theme: string) {
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
}

export const scrollGap = (scroller: HTMLElement) =>
  scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

export const rowOffset = (scroller: HTMLElement, row: HTMLElement) =>
  row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

export function scrollTo(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

export const nextPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
