"""Extract emails and meetings via Microsoft Graph API."""
from shared.progress import send_progress
from graph.outlook_client import get_timekeeper_outlook_client


def run_extract(start_date: str, end_date: str, types: list[str], include_tentative: bool = False) -> dict:
    result = {
        "success": True,
        "data": [],
        "counts": {},
        "errors": [],
    }

    send_progress("connecting", "Connecting to Microsoft 365...", 0, 0)
    client = get_timekeeper_outlook_client()

    def email_progress(current: int, total: int, message: str) -> None:
        send_progress("scanning_emails", message, current, total or current or 1)

    def meeting_progress(current: int, total: int, message: str) -> None:
        send_progress("scanning_meetings", message, current, total or current or 1)

    if "email" in types:
        send_progress("scanning_emails", "Fetching sent emails from Microsoft Graph...", 0, 0)
        emails = client.get_sent_items_for_timekeeper(
            start_date, end_date, on_progress=email_progress
        )
        result["data"].extend(emails)
        result["counts"]["email"] = len(emails)

    if "meeting" in types:
        send_progress("scanning_meetings", "Fetching calendar from Microsoft Graph...", 0, 0)
        meetings = client.get_calendar_events_for_timekeeper(
            start_date, end_date, on_progress=meeting_progress
        )
        result["data"].extend(meetings)
        result["counts"]["meeting"] = len(meetings)

    send_progress(
        "complete",
        f"Extraction complete: {len(result['data'])} items",
        len(result["data"]),
        len(result["data"]),
    )
    return result
