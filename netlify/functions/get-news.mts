import type { Context, Config } from "@netlify/functions";

interface Story {
  headline: string;
  source: string;
  date: string;
  iso_date: string;
  summary: string;
  url: string;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
  const match = xml.match(regex);
  if (!match) return "";
  let content = match[1];
  const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) content = cdataMatch[1];
  return content.trim();
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

function parseRssItems(xmlText: string): { title: string; link: string; pubDate: string; description: string }[] {
  const items: { title: string; link: string; pubDate: string; description: string }[] = [];
  const itemMatches = xmlText.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const itemXml of itemMatches) {
    items.push({
      title: extractTag(itemXml, "title"),
      link: extractTag(itemXml, "link"),
      pubDate: extractTag(itemXml, "pubDate"),
      description: extractTag(itemXml, "description"),
    });
  }
  return items;
}

function formatDate(d: Date): string {
  const day = d.getDate();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return day + " " + months[d.getMonth()] + " " + d.getFullYear();
}

async function fetchFeed(url: string, sourceName: string, sevenDaysAgo: number, filterFn?: (title: string, description: string) => boolean): Promise<Story[]> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TigersBulletinBot/1.0)" },
    });
    if (!response.ok) {
      console.warn(sourceName + " feed returned status " + response.status);
      return [];
    }
    const xmlText = await response.text();
    const items = parseRssItems(xmlText);
    const stories: Story[] = [];

    for (const item of items) {
      if (!item.title || !item.link) continue;
      if (filterFn && !filterFn(item.title, item.description)) continue;

      const parsedDate = item.pubDate ? new Date(item.pubDate) : null;
      const validDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : null;

      if (validDate && validDate.getTime() < sevenDaysAgo) continue;

      const isoDate = validDate ? validDate.toISOString().slice(0, 10) : "";
      const humanDate = validDate ? formatDate(validDate) : "";
      const summary = stripHtml(item.description).slice(0, 220);

      stories.push({
        headline: stripHtml(item.title),
        source: sourceName,
        date: humanDate,
        iso_date: isoDate,
        summary: summary,
        url: item.link,
      });
    }
    return stories;
  } catch (err) {
    console.warn(sourceName + " feed fetch failed:", err);
    return [];
  }
}

export default async (req: Request, context: Context) => {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const results = await Promise.allSettled([
      fetchFeed(
        "https://feeds.bbci.co.uk/sport/football/teams/hull-city/rss.xml",
        "BBC Sport",
        sevenDaysAgo
      ),
      fetchFeed(
        "https://www.skysports.com/rss/12040",
        "Sky Sports",
        sevenDaysAgo,
        (title, description) => (title + " " + description).toLowerCase().includes("hull")
      ),
      fetchFeed(
        "https://www.hulldailymail.co.uk/all-about/hull-city?service=rss",
        "Hull Live",
        sevenDaysAgo
      ),
      fetchFeed(
        "https://www.yorkshirepost.co.uk/sport/football/hull-city/rss",
        "Yorkshire Post",
        sevenDaysAgo
      ),
      fetchFeed(
        "https://footballleagueworld.co.uk/feed/tag/hull-city/",
        "Football League World",
        sevenDaysAgo
      ),
      fetchFeed(
        "https://the72.co.uk/category/hull-city/feed/",
        "The72",
        sevenDaysAgo
      ),
    ]);

    let allStories: Story[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allStories = allStories.concat(result.value);
      }
    }

    allStories.sort((a, b) => {
      const dateA = a.iso_date ? Date.parse(a.iso_date) : 0;
      const dateB = b.iso_date ? Date.parse(b.iso_date) : 0;
      return dateB - dateA;
    });

    return new Response(JSON.stringify({ stories: allStories.slice(0, 10) }), {
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
};
