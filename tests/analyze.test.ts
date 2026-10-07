import { describe, expect, test } from "bun:test"
import {
  heuristicAnalysis,
  levelFor,
  mergeAnalysis,
  scoreSegment,
  segmentText,
} from "../lib/tui/analyze"

describe("levelFor", () => {
  test("maps score bands", () => {
    expect(levelFor(0.7)).toBe("good")
    expect(levelFor(0.69)).toBe("ok")
    expect(levelFor(0.4)).toBe("ok")
    expect(levelFor(0.39)).toBe("weak")
    expect(levelFor(0)).toBe("weak")
  })
})

describe("segmentText", () => {
  test("splits into sentences", () => {
    const parts = segmentText("Fix the bug. Add a test.")
    expect(parts.length).toBe(2)
    expect(parts[0]).toContain("Fix the bug")
    expect(parts[1]).toContain("Add a test")
  })

  test("returns nothing for blank input", () => {
    expect(segmentText("   ")).toEqual([])
  })
})

describe("scoreSegment", () => {
  test("short vague text is weak and carries tips", () => {
    const scored = scoreSegment("fix it")
    expect(scored.level).toBe("weak")
    expect(scored.tips.length).toBeGreaterThan(0)
  })

  test("specific actionable text scores good", () => {
    const scored = scoreSegment(
      "Add a `--dry-run` flag to src/deploy.ts so that it must print the resolved plan and exit before any writes.",
    )
    expect(scored.level).toBe("good")
    expect(scored.score).toBeGreaterThan(0.7)
  })

  test("questions are flagged", () => {
    const scored = scoreSegment("Can you make it better?")
    expect(scored.tips.join(" ")).toMatch(/instruction/i)
    expect(scored.level).not.toBe("good")
  })
})

describe("heuristicAnalysis", () => {
  test("aggregates segments, caps tips, stays heuristic tier", () => {
    const analysis = heuristicAnalysis(
      "fix it. Add the `--dry-run` flag to src/deploy.ts so that it must print the plan.",
    )
    expect(analysis.tier).toBe("heuristic")
    expect(analysis.segments.length).toBe(2)
    expect(analysis.tips.length).toBeLessThanOrEqual(3)
    expect(new Set(analysis.tips).size).toBe(analysis.tips.length)
    expect(analysis.score).toBeGreaterThan(0)
    expect(analysis.score).toBeLessThanOrEqual(1)
  })

  test("blank draft yields no segments", () => {
    const analysis = heuristicAnalysis("")
    expect(analysis.segments).toEqual([])
    expect(analysis.level).toBe("weak")
  })
})

describe("mergeAnalysis", () => {
  test("blends model signal and marks s1 tier", () => {
    const base = heuristicAnalysis(
      "Add the `--dry-run` flag to src/deploy.ts so that it must print the plan.",
    )
    const merged = mergeAnalysis(base, [0.1])
    expect(merged.tier).toBe("s1")
    expect(merged.segments[0]!.score).toBeLessThan(base.segments[0]!.score)
    expect(merged.segments[0]!.score).toBeGreaterThanOrEqual(0)
  })

  test("missing model score falls back to heuristic", () => {
    const base = heuristicAnalysis("Add a test for the parser in src/parse.ts.")
    const merged = mergeAnalysis(base, [])
    expect(merged.segments[0]!.score).toBe(base.segments[0]!.score)
  })
})
