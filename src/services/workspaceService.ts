import { CalendarEventSummary, DriveFileSummary, GmailMessageSummary } from '../types';

function encodeBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeMimeSubject(subject: string): string {
  const bytes = new TextEncoder().encode(subject);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

export async function fetchGmailMessages(
  accessToken: string,
  query = '',
  maxResults = 8
): Promise<GmailMessageSummary[]> {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (query.trim()) {
    params.set('q', query.trim());
  }

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!listRes.ok) {
    const errText = await listRes.text();
    throw new Error(`Gmail okuma hatası (${listRes.status}): ${errText}`);
  }

  const listData = (await listRes.json()) as {
    messages?: Array<{ id: string; threadId: string }>;
  };
  const messages = listData.messages ?? [];
  if (messages.length === 0) return [];

  const detailed = await Promise.all(
    messages.slice(0, maxResults).map(async (m) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (!msgRes.ok) return null;
      const msgJson = (await msgRes.json()) as {
        id: string;
        threadId: string;
        snippet?: string;
        labelIds?: string[];
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const headers = msgJson.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      return {
        id: msgJson.id,
        threadId: msgJson.threadId,
        from: getHeader('From') || 'Bilinmeyen Gönderen',
        subject: getHeader('Subject') || '(Konu Yok)',
        date: getHeader('Date') || '',
        snippet: msgJson.snippet || '',
        unread: Boolean(msgJson.labelIds?.includes('UNREAD')),
      } satisfies GmailMessageSummary;
    })
  );

  return detailed.filter((item): item is GmailMessageSummary => item !== null);
}

export async function sendGmailMessage(
  accessToken: string,
  to: string,
  subject: string,
  body: string
): Promise<{ id: string }> {
  const mimeLines = [
    `To: ${to}`,
    `Subject: ${encodeMimeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ];
  const raw = encodeBase64Url(mimeLines.join('\r\n'));

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`E-posta gönderilemedi (${res.status}): ${errText}`);
  }

  return (await res.json()) as { id: string };
}

export async function fetchCalendarEvents(
  accessToken: string,
  daysAhead = 5,
  maxResults = 10
): Promise<CalendarEventSummary[]> {
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Takvim okuma hatası (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      location?: string;
      description?: string;
      htmlLink?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
  };

  return (data.items ?? []).map((ev) => ({
    id: ev.id,
    summary: ev.summary || '(İsimsiz Etkinlik)',
    start: ev.start?.dateTime || ev.start?.date || '',
    end: ev.end?.dateTime || ev.end?.date || '',
    location: ev.location,
    description: ev.description,
    htmlLink: ev.htmlLink,
  }));
}

export async function createCalendarEvent(
  accessToken: string,
  payload: {
    summary: string;
    startIso: string;
    endIso: string;
    description?: string;
    location?: string;
  }
): Promise<CalendarEventSummary> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: payload.summary,
        description: payload.description || '',
        location: payload.location || '',
        start: { dateTime: payload.startIso },
        end: { dateTime: payload.endIso },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Takvim etkinliği oluşturulamadı (${res.status}): ${errText}`);
  }

  const ev = (await res.json()) as {
    id: string;
    summary?: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
    location?: string;
    description?: string;
    htmlLink?: string;
  };

  return {
    id: ev.id,
    summary: ev.summary || payload.summary,
    start: ev.start?.dateTime || payload.startIso,
    end: ev.end?.dateTime || payload.endIso,
    location: ev.location,
    description: ev.description,
    htmlLink: ev.htmlLink,
  };
}

export async function fetchDriveFiles(
  accessToken: string,
  query = '',
  pageSize = 8
): Promise<DriveFileSummary[]> {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
  });

  if (query.trim()) {
    const escaped = query.trim().replace(/'/g, "\\'");
    params.set('q', `name contains '${escaped}' and trashed = false`);
  } else {
    params.set('q', 'trashed = false');
  }

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Drive okuma hatası (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { files?: DriveFileSummary[] };
  return data.files ?? [];
}
