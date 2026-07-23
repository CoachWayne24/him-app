// Supabase Edge Function: team-calendar
// Serves a live, auto-updating iCalendar (.ics) feed for a team's events.
// Public and unauthenticated on purpose — calendar apps (Google/Outlook/Apple)
// can't send a login header when they periodically re-fetch a subscribed feed.
// Instead, access is gated by a long random `token` per team (teams.calendar_token),
// which acts like a password baked into the URL — nobody can guess it, and a coach
// can regenerate a new one from the app any time to invalidate the old link.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function toICSDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeICS(text: string): string {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: team, error: teamErr } = await supabase
    .from("teams")
    .select("id, name")
    .eq("calendar_token", token)
    .maybeSingle();

  if (teamErr || !team) {
    return new Response("Invalid or expired calendar link.", { status: 404 });
  }

  const { data: events } = await supabase
    .from("team_events")
    .select("*")
    .eq("team_id", team.id)
    .order("start_time");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HIM App//Team Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeICS(team.name)} Schedule`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];

  for (const ev of events ?? []) {
    const start = new Date(ev.start_time);
    const end = new Date(start.getTime() + 90 * 60 * 1000); // default 90-minute block
    const summaryPrefix = ev.event_type === "game" ? "🏀 " : ev.event_type === "practice" ? "🟠 " : "";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.id}@him-app`,
      `DTSTAMP:${toICSDate(new Date().toISOString())}`,
      `DTSTART:${toICSDate(start.toISOString())}`,
      `DTEND:${toICSDate(end.toISOString())}`,
      `SUMMARY:${escapeICS(summaryPrefix + (ev.title || "Team Event"))}`,
      ev.location ? `LOCATION:${escapeICS(ev.location)}` : "",
      ev.notes ? `DESCRIPTION:${escapeICS(ev.notes)}` : "",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.filter(Boolean).join("\r\n"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
});
