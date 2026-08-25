import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { insertSourceIfNew, processStaleSourcesAfterImport, getSetting } from '@/lib/db';
import {
  buildOutlookPythonEnv,
  getEffectiveOutlookBackend,
  getOutlookScriptPath,
  getPythonCommandForSpawn,
  runOutlookPythonScript,
} from '@/lib/outlook-python';

export async function POST(request: Request) {
  const { startDate, endDate, types = ['email', 'meeting'] } = await request.json();

  if (!startDate || !endDate) {
    return NextResponse.json({ success: false, error: 'startDate and endDate required' }, { status: 400 });
  }

  const scriptPath = getOutlookScriptPath('outlook_extract.py');
  const backend = getEffectiveOutlookBackend();
  const includeTentative = getSetting('include_tentative_meetings') === 'true';

  if (backend === 'graph') {
    try {
      const { stdout, code } = await runOutlookPythonScript('outlook_auth.py', [
        'status',
      ]);
      if (code === 0) {
        const status = JSON.parse(stdout) as { connected?: boolean; configured?: boolean };
        if (!status.configured) {
          return NextResponse.json(
            {
              success: false,
              error:
                'Microsoft Graph is not configured. Add your Azure Client ID in Settings.',
            },
            { status: 400 }
          );
        }
        if (!status.connected) {
          return NextResponse.json(
            {
              success: false,
              error:
                'Outlook is not connected. Sign in under Settings → Outlook (Microsoft Graph).',
            },
            { status: 401 }
          );
        }
      }
    } catch {
      // Continue — extract script will surface auth errors if needed
    }
  }

  // Create a ReadableStream for SSE
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: object) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const python = spawn(
        getPythonCommandForSpawn(),
        [
          scriptPath,
          '--start-date',
          startDate,
          '--end-date',
          endDate,
          '--types',
          types.join(','),
          '--include-tentative',
          includeTentative ? 'true' : 'false',
        ],
        { env: buildOutlookPythonEnv() }
      );

      let output = '';
      let stderrBuffer = '';

      // Track extraction progress across phases (emails then meetings)
      // Progress ranges: connecting 0-5%, emails 5-25%, meetings 25-50%, importing 50-95%, cleanup 95-100%
      let lastPercent = 0;

      python.stdout.on('data', (data) => {
        output += data.toString();
      });

      // Handle stderr for progress updates from Python
      python.stderr.on('data', (data) => {
        stderrBuffer += data.toString();

        // Process complete lines
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            try {
              const progressData = JSON.parse(line);
              if (progressData.type === 'progress') {
                let percent = lastPercent;

                if (progressData.stage === 'connecting') {
                  percent = 2;
                } else if (progressData.stage === 'scanning_emails') {
                  // Emails: 5-25%
                  if (progressData.total > 0) {
                    percent = Math.round(5 + (progressData.current / progressData.total) * 20);
                  } else {
                    percent = 5;
                  }
                } else if (progressData.stage === 'scanning_meetings') {
                  // Meetings: 25-50%
                  if (progressData.total > 0) {
                    percent = Math.round(25 + (progressData.current / progressData.total) * 25);
                  } else {
                    percent = 25;
                  }
                } else if (progressData.stage === 'complete') {
                  percent = 50;
                }

                // Only send if percent increased (never go backwards)
                if (percent > lastPercent) {
                  lastPercent = percent;
                  sendEvent({
                    type: 'progress',
                    stage: 'extracting',
                    message: progressData.message,
                    percent
                  });
                }
              }
            } catch {
              // Not JSON, ignore (could be actual error output)
            }
          }
        }
      });

      python.on('close', (code) => {
        if (code !== 0 || !output) {
          sendEvent({
            type: 'error',
            error: 'Python script failed'
          });
          controller.close();
          return;
        }

        let result;
        try {
          result = JSON.parse(output);
        } catch (parseError) {
          sendEvent({
            type: 'error',
            error: `Failed to parse Python output: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            details: output.slice(0, 500)
          });
          controller.close();
          return;
        }

        try {
          if (result.success && result.data) {
            const totalItems = result.data.length;
            let processedCount = 0;
            let newCount = 0;
            let duplicateCount = 0;
            const emailCount = result.data.filter((d: { type: string }) => d.type === 'email').length;
            const meetingCount = result.data.filter((d: { type: string }) => d.type === 'meeting').length;

            // Send count before importing (50%)
            sendEvent({
              type: 'progress',
              stage: 'importing',
              message: `Importing ${emailCount} emails and ${meetingCount} meetings...`,
              percent: 50,
              newItems: 0,
              duplicates: 0
            });

            // Process each item and send progress updates
            for (const item of result.data) {
              const { inserted } = insertSourceIfNew(item.type, item.subject, item.body, item.date, item.duration_minutes, item.external_id);
              processedCount++;

              if (inserted) {
                newCount++;
              } else {
                duplicateCount++;
              }

              // Send progress update every 5 items for better performance
              // Importing: 50-95%
              if (processedCount % 5 === 0 || processedCount === totalItems) {
                const percent = Math.round(50 + (processedCount / totalItems) * 45);
                sendEvent({
                  type: 'progress',
                  stage: 'importing',
                  message: `Importing to database...`,
                  percent,
                  newItems: newCount,
                  duplicates: duplicateCount
                });
              }
            }

            // Process stale sources - identify sources in DB not returned by Outlook (95%)
            sendEvent({
              type: 'progress',
              stage: 'cleanup',
              message: 'Checking for stale sources...',
              percent: 95,
              newItems: newCount,
              duplicates: duplicateCount
            });

            const staleResult = processStaleSourcesAfterImport(
              result.data,
              startDate,
              endDate,
              types as ('email' | 'meeting')[]
            );

            // Send final result with stale counts
            sendEvent({
              type: 'complete',
              success: true,
              total: totalItems,
              newItems: newCount,
              duplicates: duplicateCount,
              staleDeleted: staleResult.deleted,
              staleMarked: staleResult.markedStale,
              staleReactivated: staleResult.reactivated,
              counts: {
                email: emailCount,
                meeting: meetingCount
              }
            });
          } else {
            sendEvent({
              type: 'complete',
              success: result.success,
              error: result.errors?.join(', ')
            });
          }
        } catch (dbError) {
          sendEvent({
            type: 'error',
            error: `Database error during import: ${dbError instanceof Error ? dbError.message : String(dbError)}`
          });
        }

        controller.close();
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
