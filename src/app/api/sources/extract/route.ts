import { NextResponse } from 'next/server';
import { insertSourceIfNew, processStaleSourcesAfterImport, getSetting } from '@/lib/db';
import {
  isOutlookConfigured,
  getAuthStatus,
  fetchSentEmails,
  fetchCalendarEvents,
} from '@/lib/outlook-graph';

export async function POST(request: Request) {
  const { startDate, endDate, types = ['email', 'meeting'] } = await request.json();

  if (!startDate || !endDate) {
    return NextResponse.json({ success: false, error: 'startDate and endDate required' }, { status: 400 });
  }

  // Check Outlook auth before starting stream
  if (!isOutlookConfigured()) {
    return NextResponse.json(
      { success: false, error: 'Microsoft Graph is not configured. Add your Azure Client ID in Settings.' },
      { status: 400 }
    );
  }

  const authStatus = await getAuthStatus();
  if (!authStatus.connected) {
    return NextResponse.json(
      { success: false, error: 'Outlook is not connected. Sign in under Settings.' },
      { status: 401 }
    );
  }

  const includeTentative = getSetting('include_tentative_meetings') === 'true';

  // Create a ReadableStream for SSE
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: object) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let lastPercent = 0;
      const sendProgress = (stage: string, message: string, percent: number) => {
        if (percent > lastPercent) {
          lastPercent = percent;
          sendEvent({ type: 'progress', stage, message, percent });
        }
      };

      try {
        sendProgress('extracting', 'Connecting to Microsoft 365...', 2);

        const allItems: { type: string; subject: string; body: string; date: string; duration_minutes?: number; external_id?: string }[] = [];

        if (types.includes('email')) {
          sendProgress('extracting', 'Fetching sent emails from Microsoft Graph...', 5);
          const emails = await fetchSentEmails(startDate, endDate, (current, total, msg) => {
            const percent = total > 0 ? Math.round(5 + (current / total) * 20) : 5;
            sendProgress('extracting', msg, percent);
          });
          allItems.push(...emails);
        }

        if (types.includes('meeting')) {
          sendProgress('extracting', 'Fetching calendar from Microsoft Graph...', 25);
          const meetings = await fetchCalendarEvents(startDate, endDate, includeTentative, (current, total, msg) => {
            const percent = total > 0 ? Math.round(25 + (current / total) * 25) : 25;
            sendProgress('extracting', msg, percent);
          });
          allItems.push(...meetings);
        }

        sendProgress('importing', `Importing ${allItems.length} items...`, 50);

        // Import to database
        const totalItems = allItems.length;
        let processedCount = 0;
        let newCount = 0;
        let duplicateCount = 0;
        const emailCount = allItems.filter((d) => d.type === 'email').length;
        const meetingCount = allItems.filter((d) => d.type === 'meeting').length;

        for (const item of allItems) {
          const { inserted } = insertSourceIfNew(item.type, item.subject, item.body, item.date, item.duration_minutes, item.external_id);
          processedCount++;
          if (inserted) newCount++;
          else duplicateCount++;

          if (processedCount % 5 === 0 || processedCount === totalItems) {
            const percent = Math.round(50 + (processedCount / totalItems) * 45);
            sendEvent({
              type: 'progress',
              stage: 'importing',
              message: 'Importing to database...',
              percent,
              newItems: newCount,
              duplicates: duplicateCount,
            });
          }
        }

        // Process stale sources
        sendEvent({ type: 'progress', stage: 'cleanup', message: 'Checking for stale sources...', percent: 95, newItems: newCount, duplicates: duplicateCount });

        const staleResult = processStaleSourcesAfterImport(
          allItems,
          startDate,
          endDate,
          types as ('email' | 'meeting')[]
        );

        sendEvent({
          type: 'complete',
          success: true,
          total: totalItems,
          newItems: newCount,
          duplicates: duplicateCount,
          staleDeleted: staleResult.deleted,
          staleMarked: staleResult.markedStale,
          staleReactivated: staleResult.reactivated,
          counts: { email: emailCount, meeting: meetingCount },
        });
      } catch (error) {
        sendEvent({
          type: 'error',
          error: error instanceof Error ? error.message : 'Extraction failed',
        });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}