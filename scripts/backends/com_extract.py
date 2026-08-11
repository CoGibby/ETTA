"""
Extract emails and meetings from Outlook via win32com (Windows desktop Outlook).
"""
from datetime import datetime, timedelta

from shared.progress import send_progress
from shared.text_utils import extract_reply_only


def is_outlook_running() -> bool:
    import subprocess

    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq OUTLOOK.EXE"],
            capture_output=True,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return "OUTLOOK.EXE" in result.stdout.upper()
    except Exception:
        return False


def start_outlook_minimized() -> None:
    import os
    import subprocess

    outlook_paths = [
        r"C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE",
        r"C:\Program Files (x86)\Microsoft Office\root\Office16\OUTLOOK.EXE",
        r"C:\Program Files\Microsoft Office\Office16\OUTLOOK.EXE",
        r"C:\Program Files (x86)\Microsoft Office\Office16\OUTLOOK.EXE",
    ]

    outlook_exe = None
    for path in outlook_paths:
        if os.path.exists(path):
            outlook_exe = path
            break

    if outlook_exe:
        subprocess.Popen(
            f'start /MIN "" "{outlook_exe}"',
            shell=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        subprocess.Popen(
            "start /MIN outlook",
            shell=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )


def get_outlook_connection(max_retries: int = 5, retry_delay: float = 3.0):
    import time

    import win32com.client

    started_fresh = False

    if not is_outlook_running():
        send_progress("connecting", "Starting Outlook...", 0, 0)
        start_outlook_minimized()
        started_fresh = True
        time.sleep(10)

    for attempt in range(max_retries):
        try:
            outlook = win32com.client.Dispatch("Outlook.Application")
            namespace = outlook.GetNamespace("MAPI")
            namespace.GetDefaultFolder(6)
            namespace.GetDefaultFolder(5)
            namespace.GetDefaultFolder(9)

            if started_fresh and attempt == 0:
                send_progress("connecting", "Waiting for mailbox data to load...", 0, 0)
                time.sleep(5)
                sent_folder = namespace.GetDefaultFolder(5)
                calendar_folder = namespace.GetDefaultFolder(9)
                _ = sent_folder.Items.Count
                _ = calendar_folder.Items.Count
                time.sleep(2)

            return namespace
        except Exception as exc:
            if attempt < max_retries - 1:
                send_progress(
                    "connecting",
                    f"Waiting for Outlook to initialize (attempt {attempt + 2}/{max_retries})...",
                    0,
                    0,
                )
                time.sleep(retry_delay)
            else:
                raise Exception(
                    f"Could not connect to Outlook after {max_retries} attempts: {exc}"
                ) from exc


def extract_emails(start_date: str, end_date: str, namespace=None) -> list:
    if namespace is None:
        namespace = get_outlook_connection()

    sent_folder = namespace.GetDefaultFolder(5)
    send_progress("scanning_emails", "Filtering sent emails...", 0, 0)

    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    filter_str = (
        f"[SentOn] >= '{start_dt.strftime('%m/%d/%Y')}' AND "
        f"[SentOn] < '{(end_dt + timedelta(days=1)).strftime('%m/%d/%Y')}'"
    )

    try:
        filtered_items = sent_folder.Items.Restrict(filter_str)
        total_filtered = filtered_items.Count
    except Exception:
        filtered_items = sent_folder.Items
        total_filtered = filtered_items.Count

    send_progress(
        "scanning_emails",
        f"Processing {total_filtered} emails...",
        0,
        total_filtered,
    )

    items = []
    scanned = 0

    for item in filtered_items:
        scanned += 1
        if scanned % 20 == 0:
            send_progress(
                "scanning_emails",
                f"Processing emails... {scanned}/{total_filtered}",
                scanned,
                total_filtered,
            )

        try:
            if item.Class != 43:
                continue

            sent_date = item.SentOn.strftime("%Y-%m-%dT%H:%M:%S")
            date_only = sent_date[:10]
            if not (start_date <= date_only <= end_date):
                continue

            subject = item.Subject or ""
            if (
                subject.startswith("Automatic reply:")
                or subject.startswith("Accepted:")
                or subject.startswith("Declined:")
                or subject.startswith("Tentative:")
            ):
                continue

            full_body = item.Body or ""
            reply_only = extract_reply_only(full_body)

            items.append(
                {
                    "type": "email",
                    "subject": subject,
                    "body": reply_only[:5000],
                    "date": sent_date,
                }
            )
        except Exception:
            continue

    send_progress(
        "scanning_emails",
        f"Found {len(items)} emails in date range",
        scanned,
        scanned,
    )
    return items


def extract_meetings(start_date: str, end_date: str, namespace=None, include_tentative: bool = False) -> list:
    """Extract accepted calendar meetings in date range.

    include_tentative: when True, also include meetings marked Tentative (ResponseStatus=1).
    Organizer-created and explicitly accepted meetings are always included.
    Declined (4) and not-responded (5) meetings are always excluded.
    """
    if namespace is None:
        namespace = get_outlook_connection()

    calendar = namespace.GetDefaultFolder(9)
    send_progress("scanning_meetings", "Filtering calendar...", 0, 0)

    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    filter_str = (
        f"[Start] >= '{start_dt.strftime('%m/%d/%Y')}' AND "
        f"[Start] < '{(end_dt + timedelta(days=1)).strftime('%m/%d/%Y')}'"
    )

    try:
        calendar_items = calendar.Items
        calendar_items.Sort("[Start]")
        calendar_items.IncludeRecurrences = True
        filtered_items = calendar_items.Restrict(filter_str)
    except Exception:
        filtered_items = calendar.Items

    send_progress("scanning_meetings", "Counting meetings...", 0, 0)
    total_meetings = 0
    for item in filtered_items:
        try:
            meeting_date = item.Start.strftime("%Y-%m-%d")
            if start_date <= meeting_date <= end_date:
                total_meetings += 1
        except Exception:
            continue

    send_progress(
        "scanning_meetings",
        f"Processing {total_meetings} meetings...",
        0,
        total_meetings,
    )

    calendar_items = calendar.Items
    calendar_items.Sort("[Start]")
    calendar_items.IncludeRecurrences = True
    filtered_items = calendar_items.Restrict(filter_str)

    items = []
    scanned = 0

    for item in filtered_items:
        scanned += 1
        if scanned % 20 == 0:
            send_progress(
                "scanning_meetings",
                f"Processing meetings... {scanned}/{total_meetings}",
                scanned,
                total_meetings,
            )

        try:
            meeting_date = item.Start.strftime("%Y-%m-%dT%H:%M:%S")
            date_only = meeting_date[:10]
            if not (start_date <= date_only <= end_date):
                continue

            response_status = getattr(item, "ResponseStatus", 0)
            meeting_status = getattr(item, "MeetingStatus", 2)
            is_organizer = meeting_status in (0, 1)

            # ETTA-34: skip private meetings (Sensitivity: 0=Normal, 1=Personal, 2=Private, 3=Confidential)
            if getattr(item, "Sensitivity", 0) == 2:
                continue

            # Default: include organizer + explicitly accepted (0, 2, 3).
            # Optional (include_tentative): also include tentative (1).
            # Always exclude declined (4) and not-responded (5).
            accepted_statuses = (0, 2, 3)
            if include_tentative:
                accepted_statuses = (0, 1, 2, 3)
            if not is_organizer and response_status not in accepted_statuses:
                continue

            duration_minutes = int(item.Duration) if hasattr(item, "Duration") else 60
            global_id = getattr(item, "GlobalAppointmentID", None) or ""

            items.append(
                {
                    "type": "meeting",
                    "subject": item.Subject or "",
                    "body": (item.Body or "")[:5000],
                    "date": meeting_date,
                    "duration_minutes": duration_minutes,
                    "external_id": global_id,
                }
            )
        except Exception:
            continue

    send_progress(
        "scanning_meetings",
        f"Found {len(items)} meetings in date range",
        scanned,
        scanned,
    )
    return items


def run_extract(start_date: str, end_date: str, types: list[str], include_tentative: bool = False) -> dict:
    result = {
        "success": True,
        "data": [],
        "counts": {},
        "errors": [],
    }

    send_progress("connecting", "Connecting to Outlook...", 0, 0)
    namespace = get_outlook_connection()

    if "email" in types:
        emails = extract_emails(start_date, end_date, namespace)
        result["data"].extend(emails)
        result["counts"]["email"] = len(emails)

    if "meeting" in types:
        meetings = extract_meetings(start_date, end_date, namespace, include_tentative=include_tentative)
        result["data"].extend(meetings)
        result["counts"]["meeting"] = len(meetings)

    send_progress(
        "complete",
        f"Extraction complete: {len(result['data'])} items",
        len(result["data"]),
        len(result["data"]),
    )
    return result
