import { useCallback, useEffect, useState } from "react";

/**
 * The router: seven screens, so the History API and two regular expressions
 * rather than a dependency.
 */

export type Route =
  | { name: "dashboard" }
  | { name: "people" }
  | { name: "personalities" }
  | { name: "person"; personId: string }
  | { name: "events" }
  | { name: "review" }
  | { name: "settings" }
  | { name: "unknown"; path: string };

export function parseRoute(path: string): Route {
  const clean = path.replace(/\/+$/, "") || "/";

  if (clean === "/") return { name: "dashboard" };
  if (clean === "/people") return { name: "people" };
  if (clean === "/personalities") return { name: "personalities" };
  if (clean === "/events") return { name: "events" };
  if (clean === "/review") return { name: "review" };
  if (clean === "/settings") return { name: "settings" };

  const person = /^\/people\/([0-9a-fA-F-]{36})$/.exec(clean);
  if (person) return { name: "person", personId: person[1] as string };

  return { name: "unknown", path: clean };
}

export function hrefOf(route: Route): string {
  switch (route.name) {
    case "dashboard":
      return "/";
    case "people":
      return "/people";
    case "personalities":
      return "/personalities";
    case "person":
      return `/people/${route.personId}`;
    case "events":
      return "/events";
    case "review":
      return "/review";
    case "settings":
      return "/settings";
    default:
      return route.path;
  }
}

export function navigate(path: string): void {
  if (path === `${window.location.pathname}${window.location.search}`) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return parseRoute(path);
}

/** For an anchor that should navigate without a page load. */
export function useLinkHandler(): (event: React.MouseEvent<HTMLAnchorElement>) => void {
  return useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const href = event.currentTarget.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    event.preventDefault();
    navigate(href);
  }, []);
}
