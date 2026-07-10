"use client";

/**
 * Module-level session cache.
 *
 * Next.js App Router unmounts a page's component when you navigate to another
 * tab, so local React state (search results, eval run) is lost on return. These
 * module variables live for the life of the loaded JS bundle — i.e. across
 * client-side navigation, but reset on a full page reload — so a user can switch
 * tabs and come back to their results without re-running.
 */

import type { CaseResult, Aggregate } from "./evals";

export const evalCache: {
  results: CaseResult[];
  agg: Aggregate | null;
  useJudge: boolean;
} = { results: [], agg: null, useJudge: true };

// The Explore result shape lives in the page; keep this loosely typed.
export const exploreCache: { question: string; result: unknown | null } = {
  question: "",
  result: null,
};
