import type { Context, Config } from "@netlify/functions";

const PROMPT = "Search the web for the latest news about Hull City AFC (the English football club, nicknamed The Tigers, playing in the EFL Championship). Use at most 4 search queries total. Prioritize reputable football/sports sources such as BBC Sport, Sky Sports, Hull Live / Hull Daily Mail, or the club's official site, and include the 1904 Podcast (the Hull City fan podcast) if relevant recent content exists. When a story comes from the 1904 Podcast, set \"source\" to \"1904 Podcast\". Find exactly 5 distinct, recent stories - do not search for more than that. For the \"url\" field, you MUST use the exact, specific article URL returned in your search results for that story - never the publication's homepage, a section front page (like /football or /news), or a guessed/shortened URL. If you cannot find the specific article URL for a story, exclude that story rather than substituting a homepage link. Respond with ONLY a raw JSON array (no markdown fences, no commentary) where each item has exactly these keys: \"headline\" (string, in your own words), \"source\" (string, publication name), \"date\" (string, human-readable, e.g. '12 Jul 2026'), \"iso_date\" (string, YYYY-MM-DD, best estimate if unstated), \"summary\" (string, 1-2 sentences in your own words, never a direct quote), \"url\" (string, the exact direct article URL from search results). Order the array with the newest story first. Return nothing except that JSON array.";

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
        max_tokens: 4000,
        messages: [{ role: "user", content: PROMPT }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
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
        if (wordsB.has(w
