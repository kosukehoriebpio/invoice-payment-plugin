#!/usr/bin/env python3
"""
Step 2: 請求書読取・データ化（PDF構造パース）

pdfplumber でPDFのテキストレイヤーから請求書データを構造化抽出する。
テキストレイヤーがない画像PDFは extraction_method: "vision_required" として
後続のClaude Visionフォールバックに委ねる。

Usage:
    python scripts/extract.py <workDir> [--manifest _manifest.json]

Output:
    {workDir}/_extracted.json

依存:
    pip install pdfplumber
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import pdfplumber


# ============================================================
# Types / Constants
# ============================================================

DATE_PATTERNS = [
    # 2026年3月25日, 2026/03/25, 2026-03-25
    (r"(\d{4})\s*[年/\-\.]\s*(\d{1,2})\s*[月/\-\.]\s*(\d{1,2})\s*日?", "{}-{:02d}-{:02d}"),
    # 令和8年3月25日
    (r"令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", "reiwa"),
]

BANK_NAMES_PATTERN = re.compile(
    r"([\u4e00-\u9fa5ぁ-んァ-ヶA-Za-z]+(?:銀行|信用金庫|信金|信用組合|農協|労金))"
)
BRANCH_PATTERN = re.compile(r"([\u4e00-\u9fa5ぁ-んァ-ヶA-Za-z]+支店)")
ACCOUNT_NUM_PATTERN = re.compile(r"(?:口座番号|No\.?)\s*[:：]?\s*(\d{6,8})")
ACCOUNT_TYPE_PATTERN = re.compile(r"(普通|当座|貯蓄)")
ACCOUNT_HOLDER_PATTERN = re.compile(
    r"(?:口座名義|名義人?|フリガナ)\s*[:：]?\s*([ァ-ヶー\s（）\(\)A-Z\u4e00-\u9fa5]{2,})"
)

INVOICE_NO_PATTERN = re.compile(
    r"(?:請求書番号|請求番号|Invoice\s*(?:No\.?|Number|#)|No\.)\s*[:：]?\s*([A-Za-z0-9\-_]+)"
)
REGISTRATION_NO_PATTERN = re.compile(r"(T\d{13})")

# ¥ / ￥ / \ (backslash = yen in many JP PDFs)
AMOUNT_PATTERN = re.compile(r"[¥￥\\]\s*([\d,]+)")
TAX_RATE_PATTERN = re.compile(r"(\d+)\s*%")


# ============================================================
# Date Parsing
# ============================================================

def parse_date(text: str) -> str | None:
    """Extract the first date found in text, return as YYYY-MM-DD."""
    for pattern, fmt in DATE_PATTERNS:
        m = re.search(pattern, text)
        if not m:
            continue
        if fmt == "reiwa":
            year = 2018 + int(m.group(1))
            return f"{year}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        return fmt.format(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def parse_all_dates(text: str) -> list[str]:
    """Extract all dates from text."""
    dates = []
    for pattern, fmt in DATE_PATTERNS:
        for m in re.finditer(pattern, text):
            if fmt == "reiwa":
                year = 2018 + int(m.group(1))
                dates.append(f"{year}-{int(m.group(2)):02d}-{int(m.group(3)):02d}")
            else:
                dates.append(fmt.format(int(m.group(1)), int(m.group(2)), int(m.group(3))))
    return dates


# ============================================================
# Amount Parsing
# ============================================================

def parse_amount(s: str) -> int:
    """Parse a currency string like '¥1,234,567' or '1234567' to int."""
    cleaned = re.sub(r"[¥￥\\,\s円\-]", "", s)
    try:
        return int(cleaned)
    except ValueError:
        return 0


def find_amounts(text: str) -> list[int]:
    """Find all yen amounts in text."""
    matches = AMOUNT_PATTERN.findall(text)
    return [parse_amount(m) for m in matches if parse_amount(m) > 0]


def find_labeled_amount(text: str, label: str) -> int | None:
    """Find an amount associated with a label, e.g. '合計 ¥123,456'."""
    pattern = re.compile(
        rf"{label}\s*[:：]?\s*[¥￥\\]?\s*([\d,]+)", re.IGNORECASE
    )
    m = pattern.search(text)
    if m:
        return parse_amount(m.group(1))
    return None


# ============================================================
# Bank Account Extraction
# ============================================================

def extract_bank_account(text: str) -> dict:
    """Extract bank account info from text."""
    account = {
        "bankName": "",
        "branchName": "",
        "accountType": "普通",
        "accountNumber": "",
        "accountHolder": "",
    }

    m = BANK_NAMES_PATTERN.search(text)
    if m:
        account["bankName"] = m.group(1)

    m = BRANCH_PATTERN.search(text)
    if m:
        account["branchName"] = m.group(1)

    m = ACCOUNT_NUM_PATTERN.search(text)
    if m:
        account["accountNumber"] = m.group(1)

    m = ACCOUNT_TYPE_PATTERN.search(text)
    if m:
        account["accountType"] = m.group(1)

    m = ACCOUNT_HOLDER_PATTERN.search(text)
    if m:
        account["accountHolder"] = m.group(1).strip()

    return account


# ============================================================
# Table Extraction (for line items)
# ============================================================

def extract_tables_from_page(page) -> list[list[list[str]]]:
    """Extract tables from a pdfplumber page."""
    tables = page.extract_tables()
    if not tables:
        return []
    # Clean cell values
    cleaned = []
    for table in tables:
        rows = []
        for row in table:
            rows.append([str(cell).strip() if cell else "" for cell in row])
        cleaned.append(rows)
    return cleaned


def parse_line_items(tables: list[list[list[str]]]) -> list[dict]:
    """Try to parse line items from extracted tables."""
    items = []
    for table in tables:
        if len(table) < 2:
            continue
        header = table[0]

        # Find column indices by header keywords
        col_map = {}
        for i, h in enumerate(header):
            h_lower = h.lower().replace(" ", "")
            if any(k in h_lower for k in ["品名", "品目", "摘要", "内容", "項目", "item", "description"]):
                col_map["item"] = i
            elif any(k in h_lower for k in ["数量", "qty", "quantity"]):
                col_map["quantity"] = i
            elif any(k in h_lower for k in ["単価", "unitprice", "price"]):
                col_map["unitPrice"] = i
            elif any(k in h_lower for k in ["金額", "amount", "計", "小計"]):
                col_map["amount"] = i
            elif any(k in h_lower for k in ["税率", "taxrate", "tax"]):
                col_map["taxRate"] = i
            elif any(k in h_lower for k in ["単位", "unit"]):
                col_map["unit"] = i

        if "item" not in col_map and "amount" not in col_map:
            continue  # Not a line items table

        for row in table[1:]:
            if len(row) <= max(col_map.values(), default=0):
                continue
            item_text = row[col_map["item"]] if "item" in col_map else ""
            if not item_text or item_text == "":
                continue

            item = {
                "item": item_text,
                "quantity": 0,
                "unit": "",
                "unitPrice": 0,
                "taxRate": 0.10,
                "amount": 0,
            }
            if "quantity" in col_map:
                try:
                    item["quantity"] = float(re.sub(r"[^\d.]", "", row[col_map["quantity"]]) or "0")
                except ValueError:
                    pass
            if "unitPrice" in col_map:
                item["unitPrice"] = parse_amount(row[col_map["unitPrice"]])
            if "amount" in col_map:
                item["amount"] = parse_amount(row[col_map["amount"]])
            if "taxRate" in col_map:
                rate_m = TAX_RATE_PATTERN.search(row[col_map["taxRate"]])
                if rate_m:
                    item["taxRate"] = int(rate_m.group(1)) / 100
            if "unit" in col_map:
                item["unit"] = row[col_map["unit"]]

            items.append(item)

    return items


# ============================================================
# Invoice Section Detection
# ============================================================

def detect_vendor_name(text: str) -> str:
    """Detect vendor/company name from invoice text.

    Strategy:
    1. Find the 御中 marker — text BEFORE it is the recipient, text AFTER is the sender/vendor
    2. If no 御中, look for company names in the top portion and pick the first non-header one
    """
    import unicodedata
    text = unicodedata.normalize("NFKC", text)
    top_text = text[:800]

    entity_re = r"(?:株式会社|合同会社|有限会社|一般社団法人|一般財団法人|医療法人)"
    company_patterns = [
        re.compile(rf"({entity_re}[\u4e00-\u9fa5ぁ-んァ-ヶA-Za-z0-9\s・\-]+?)(?:\s|$|\n|TEL|〒|登録|請求|担当)"),
        re.compile(rf"([\u4e00-\u9fa5ぁ-んァ-ヶA-Za-z0-9\s・\-]+?{entity_re})(?:\s|$|\n|TEL|〒|登録|請求|担当)"),
    ]

    # Strategy 1: Use 御中 as a delimiter — vendor is after 御中
    gochuu_pos = top_text.find("御中")
    if gochuu_pos >= 0:
        after_gochuu = top_text[gochuu_pos + 2:]
        for pat in company_patterns:
            m = pat.search(after_gochuu)
            if m:
                return m.group(1).strip()

    # Strategy 2: Find all company names, skip ones near 御中/宛/様
    skip_markers = {"御中", "宛", "ご請求先", "請求先"}
    for pat in company_patterns:
        for m in pat.finditer(top_text):
            name = m.group(1).strip()
            # Check surrounding context for recipient markers
            ctx = top_text[max(0, m.start() - 20):m.end() + 20]
            if any(marker in ctx for marker in skip_markers):
                continue
            # Skip if it looks like a heading
            if re.match(r"^(ご\s*請\s*求|請\s*求\s*書)", name):
                continue
            return name

    return ""


def detect_invoice_type(text: str) -> str:
    """Detect if this is an invoice, receipt, etc."""
    if re.search(r"請\s*求\s*書", text[:200]):
        return "invoice"
    if re.search(r"領\s*収\s*書", text[:200]):
        return "receipt"
    if re.search(r"納\s*品\s*書", text[:200]):
        return "delivery"
    return "unknown"


# ============================================================
# Single PDF Extraction
# ============================================================

def extract_single_pdf(file_path: str, invoice_id: str) -> dict:
    """Extract structured data from a single PDF file."""
    result = {
        "id": invoice_id,
        "sourceFile": file_path,
        "extraction_method": "pdfplumber",
        "vendorName": "",
        "invoiceNumber": "",
        "invoiceDate": None,
        "dueDate": None,
        "subtotal": 0,
        "taxAmount": 0,
        "totalAmount": 0,
        "taxBreakdown": [],
        "withholdingTax": None,
        "bankAccount": {
            "bankName": "", "branchName": "", "accountType": "普通",
            "accountNumber": "", "accountHolder": "",
        },
        "lineItems": [],
        "registrationNumber": None,
        "confidence": "high",
        "warnings": [],
    }

    try:
        # Note: each PDF is opened/closed individually. For typical invoice volumes
        # (10-30/month) this is fine. If processing 100+ files, consider batching.
        pdf = pdfplumber.open(file_path)
    except Exception as e:
        result["extraction_method"] = "vision_required"
        result["confidence"] = "none"
        result["warnings"].append(f"PDF open failed: {e}")
        return result

    full_text = ""
    all_tables = []

    for page in pdf.pages:
        page_text = page.extract_text() or ""
        full_text += page_text + "\n"
        all_tables.extend(extract_tables_from_page(page))

    pdf.close()

    # Check if we got meaningful text
    text_stripped = re.sub(r"\s+", "", full_text)
    if len(text_stripped) < 30:
        result["extraction_method"] = "vision_required"
        result["confidence"] = "none"
        result["warnings"].append("No text layer found (image PDF)")
        return result

    # Normalize CJK compatibility ideographs (⾦→金, ⼝→口, etc.)
    import unicodedata
    norm_text = unicodedata.normalize("NFKC", full_text)

    # --- Extract fields ---

    # Vendor name
    result["vendorName"] = detect_vendor_name(norm_text)
    if not result["vendorName"]:
        result["warnings"].append("Vendor name not detected")

    # Invoice number
    m = INVOICE_NO_PATTERN.search(norm_text)
    if m:
        result["invoiceNumber"] = m.group(1)

    # Registration number (T + 13 digits)
    m = REGISTRATION_NO_PATTERN.search(norm_text)
    if m:
        result["registrationNumber"] = m.group(1)

    # Dates
    dates = parse_all_dates(norm_text)
    if dates:
        result["invoiceDate"] = dates[0]  # First date = invoice date (heuristic)
        if len(dates) >= 2:
            result["dueDate"] = dates[-1]  # Last date = due date (heuristic)

    # Amounts — look for labeled amounts first
    # Normalize CJK compatibility ideographs before amount search
    # Common in PDF: ⾦→金, ⾷→食, ⼝→口, ⼩→小, ⽀→支, ⽇→日, etc.
    import unicodedata
    norm_text = unicodedata.normalize("NFKC", full_text)

    total = find_labeled_amount(norm_text, r"(?:合\s*計|総\s*額|ご請求金額|請求金額|お支払い?金額)")
    subtotal = find_labeled_amount(norm_text, r"(?:小\s*計|税抜[き]?金額|税抜合計)")
    tax = find_labeled_amount(norm_text, r"(?:消費税|税\s*額|うち消費税)")

    # Also try "合計（税込）\341,000" pattern (label then yen on same line)
    if not total:
        combo_pattern = re.compile(
            r"(?:合\s*計|ご請求金額|請求金額).*?[¥￥\\]\s*([\d,]+)", re.IGNORECASE
        )
        m = combo_pattern.search(norm_text)
        if m:
            total = parse_amount(m.group(1))

    if total:
        result["totalAmount"] = total
    if subtotal:
        result["subtotal"] = subtotal
    if tax:
        result["taxAmount"] = tax

    # Infer missing amounts
    if result["totalAmount"] and result["subtotal"] and not result["taxAmount"]:
        result["taxAmount"] = result["totalAmount"] - result["subtotal"]
    elif result["totalAmount"] and result["taxAmount"] and not result["subtotal"]:
        result["subtotal"] = result["totalAmount"] - result["taxAmount"]
    elif result["subtotal"] and result["taxAmount"] and not result["totalAmount"]:
        result["totalAmount"] = result["subtotal"] + result["taxAmount"]

    # If no labeled amounts found, take the largest number as total
    if not result["totalAmount"]:
        amounts = find_amounts(norm_text)
        if amounts:
            result["totalAmount"] = max(amounts)
            result["confidence"] = "low"
            result["warnings"].append("Total guessed from largest amount in document")

    # Tax breakdown
    tax_10 = find_labeled_amount(norm_text, r"(?:10\s*%\s*対象|対象.*10\s*%)")
    tax_8 = find_labeled_amount(norm_text, r"(?:8\s*%\s*対象|対象.*8\s*%|軽減.*対象)")
    if tax_10:
        result["taxBreakdown"].append({"rate": 0.10, "subtotal": tax_10, "tax": round(tax_10 * 0.10)})
    if tax_8:
        result["taxBreakdown"].append({"rate": 0.08, "subtotal": tax_8, "tax": round(tax_8 * 0.08)})

    # Withholding tax
    wht = find_labeled_amount(norm_text, r"(?:源泉徴収|源泉所得税|源泉税)")
    if wht:
        result["withholdingTax"] = wht

    # Bank account
    result["bankAccount"] = extract_bank_account(norm_text)

    # Line items from tables
    result["lineItems"] = parse_line_items(all_tables)

    # Confidence assessment
    if result["totalAmount"] and result["vendorName"] and result["confidence"] != "low":
        result["confidence"] = "high"
    elif result["totalAmount"]:
        result["confidence"] = "medium"
    else:
        result["confidence"] = "low"
        result["warnings"].append("Could not determine total amount")

    return result


# ============================================================
# Main
# ============================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: python extract.py <workDir> [--manifest _manifest.json]", file=sys.stderr)
        sys.exit(1)

    work_dir = sys.argv[1]
    manifest_name = "_manifest.json"

    for i in range(2, len(sys.argv)):
        if sys.argv[i] == "--manifest" and i + 1 < len(sys.argv):
            manifest_name = sys.argv[i + 1]

    # Path traversal guard
    if ".." in work_dir:
        print(f"Security: workDir must not contain '..'. Got: {work_dir}", file=sys.stderr)
        sys.exit(1)

    manifest_path = os.path.join(work_dir, manifest_name)

    # Load manifest
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        files = [
            os.path.join(work_dir, inv["file"])
            for inv in manifest.get("invoices", [])
        ]
    else:
        # No manifest — scan invoices/ directly
        invoices_dir = os.path.join(work_dir, "invoices")
        if not os.path.exists(invoices_dir):
            print(f"Error: {invoices_dir} not found", file=sys.stderr)
            sys.exit(1)
        exts = {".pdf", ".png", ".jpg", ".jpeg"}
        files = [
            os.path.join(invoices_dir, f)
            for f in sorted(os.listdir(invoices_dir))
            if os.path.splitext(f)[1].lower() in exts and not f.startswith("_")
        ]

    print(f"=== extract.py ===", file=sys.stderr)
    print(f"Work dir: {work_dir}", file=sys.stderr)
    print(f"Files: {len(files)}", file=sys.stderr)
    print(file=sys.stderr)

    invoices = []
    vision_required = []
    total_amount = 0

    work_dir_abs = os.path.abspath(work_dir)

    for i, file_path in enumerate(files):
        inv_id = f"inv-{i + 1:03d}"
        abs_file = os.path.abspath(file_path)
        # Path traversal guard: file must be under work_dir
        if not abs_file.startswith(work_dir_abs):
            print(f"\n  SKIP {file_path}: outside work directory", file=sys.stderr)
            continue
        rel_path = os.path.relpath(file_path, work_dir).replace("\\", "/")
        ext = os.path.splitext(file_path)[1].lower()

        print(f"  [{i + 1}/{len(files)}] {os.path.basename(file_path)}...", end="", file=sys.stderr)

        if ext in (".png", ".jpg", ".jpeg"):
            # Image files always need Vision
            inv = {
                "id": inv_id,
                "sourceFile": rel_path,
                "extraction_method": "vision_required",
                "vendorName": "", "invoiceNumber": "",
                "invoiceDate": None, "dueDate": None,
                "subtotal": 0, "taxAmount": 0, "totalAmount": 0,
                "taxBreakdown": [], "withholdingTax": None,
                "bankAccount": {"bankName": "", "branchName": "", "accountType": "普通", "accountNumber": "", "accountHolder": ""},
                "lineItems": [], "registrationNumber": None,
                "confidence": "none",
                "warnings": ["Image file — requires Claude Vision"],
            }
            vision_required.append(inv_id)
            print(f" → vision_required (image)", file=sys.stderr)
        else:
            inv = extract_single_pdf(file_path, inv_id)
            inv["sourceFile"] = rel_path

            if inv["extraction_method"] == "vision_required":
                vision_required.append(inv_id)
                print(f" → vision_required", file=sys.stderr)
            else:
                total_amount += inv["totalAmount"]
                conf = inv["confidence"]
                warns = f" [{', '.join(inv['warnings'])}]" if inv["warnings"] else ""
                print(f" → ¥{inv['totalAmount']:,} ({conf}){warns}", file=sys.stderr)

        invoices.append(inv)

    # Output
    output = {
        "extractedAt": datetime.now().isoformat(),
        "method": "pdfplumber+vision_fallback",
        "totalCount": len(invoices),
        "structureParsed": len(invoices) - len(vision_required),
        "visionRequired": len(vision_required),
        "visionRequiredIds": vision_required,
        "invoices": invoices,
    }

    output_path = os.path.join(work_dir, "_extracted.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # Summary
    parsed_count = len(invoices) - len(vision_required)
    print(file=sys.stderr)
    print(f"=== Summary ===", file=sys.stderr)
    print(f"  Total files: {len(invoices)}", file=sys.stderr)
    print(f"  Structure parsed: {parsed_count} (¥{total_amount:,})", file=sys.stderr)
    print(f"  Vision required: {len(vision_required)}", file=sys.stderr)
    if vision_required:
        print(f"  Vision IDs: {', '.join(vision_required)}", file=sys.stderr)
    print(f"  Output: {output_path}", file=sys.stderr)

    # stdout: output path
    print(output_path)


if __name__ == "__main__":
    main()
