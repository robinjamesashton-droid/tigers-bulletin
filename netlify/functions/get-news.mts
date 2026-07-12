import type { Context, Config } from "@netlify/functions";

function buildPrompt(): string {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  return "Today's date is " + todayStr + ". Use EXACTLY ONE web search query, no more: search for \"Hull City AFC news\". From the results of that single search, only use stories from these approved sources: Hull Live/Hull Daily Mail (hulldailymail.co.uk), Sky Sports, BBC Sport, the official Hull City website (wearehullcity.co.uk), and the 1904 Podcast. Discard any results from other sources. Pick up to 5 distinct stories from the approved sources, including at least one from Hull Live/Hull Daily Mail if one appears in the results. ONLY include stories published within the last 7 days (on or after " + new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + "). It is fine to return fewer than 5 stories, or even 0, if that's all that qualifies from the approved sources - do not use a second search to find more. For the \"url\" field, you MUST use the exact, specific article URL returned in your search results for that story - never a homepage, section front page, or a guessed/shortened URL. If you cannot find the specific article URL for a story, exclude that story rather than substituting a homepage link. Respond with ONLY a raw JSON array (no markdown fences, no commentary) where each item has exactly these keys: \"headline\" (string, in your own words), \"source\" (string, publication name), \"date\" (string, human-readable, e.g. '12 Jul 2026'), \"iso_date\" (string, YYYY-MM-DD, best estimate if unstated), \"summary\" (string, 1-2 sentences in your own words, never a direct quote), \"url\" (string, the exact direct article URL from search results). Order the array with the newest story first. Return nothing except that JSON array.";
}

export default async (req: Request, context: Context) => {
  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY. Add it in Site settings > Environment variables." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        messages: [{ role: "user", content: buildPrompt() }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `Anthropic API request failed (${response.status}): ${bodyText.slice(0, 300)}` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();

    const textBlocks = (data.content || [])
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("\n");

    if (!textBlocks.trim()) {
      return new Response(
        JSON.stringify({ error: "The model returned no text, it may have run out of room mid-search." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Collect the real URLs/titles that actually came back from web search,
    // so we can correct any URL the model mistyped or guessed at.
    const searchResults: { url: string; title: string }[] = [];
    for (const block of data.content || []) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item && item.url) {
            searchResults.push({ url: item.url, title: item.title || "" });
          }
        }
      }
    }

    function wordOverlapScore(a: string, b: string): number {
      const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3));
      const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3));
      let matches = 0;
      for (const w of wordsA) {
        if (wordsB.has(w)) matches++;
      }
      return matches;
    }

    function findBestMatchingUrl(headline: string, candidateUrl: string): string | undefined {
      const exact = searchResults.find((r) => r.url === candidateUrl);
      if (exact) return exact.url;

      let best: { url: string; score: number } | null = null;
      for (const r of searchResults) {
        const score = wordOverlapScore(headline, r.title);
        if (score > 0 && (!best || score > best.score)) {
          best = { url: r.url, score };
        }
      }
      return best && best.score >= 2 ? best.url : undefined;
    }

    let cleaned = textBlocks.trim();
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1) {
      cleaned = cleaned.slice(firstBracket, lastBracket + 1);
    }

    const stories = JSON.parse(cleaned);

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    let filteredStories = stories;
    if (Array.isArray(stories)) {
      for (const story of stories) {
        if (story && typeof story === "object") {
          const corrected = findBestMatchingUrl(story.headline || "", story.url || "");
          story.url = corrected || undefined;
        }
      }

      filteredStories = stories.filter((story: any) => {
        if (!story || !story.iso_date) return true; // keep if we can't tell, rather than losing it
        const parsed = Date.parse(story.iso_date);
        if (isNaN(parsed)) return true;
        return parsed >= sevenDaysAgo;
      });

      filteredStories.sort((a: any, b: any) => {
        const dateA = a && a.iso_date ? Date.parse(a.iso_date) : NaN;
        const dateB = b && b.iso_date ? Date.parse(b.iso_date) : NaN;
        if (isNaN(dateA) && isNaN(dateB)) return 0;
        if (isNaN(dateA)) return 1;
        if (isNaN(dateB)) return -1;
        return dateB - dateA;
      });
    }

    return new Response(JSON.stringify({ stories: filteredStories }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || "Unknown server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/get-news",
  timeout: 26,
};
