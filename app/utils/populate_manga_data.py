import time
import urllib.parse
import traceback
import pandas as pd
import requests
import re
import difflib
from bs4 import BeautifulSoup
from openpyxl import load_workbook

# File paths
INPUT_FILE = 'Manga.xlsx'
OUTPUT_FILE = 'Manga_updated.xlsx'

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
}

def search_manga(title):
    """Searches mangaread.org and returns the URL of the first result."""
    query = urllib.parse.quote(title)
    search_url = f'https://www.mangaread.org/?s={query}&post_type=wp-manga'
    try:
        res = requests.get(search_url, headers=HEADERS, timeout=10)
        res.raise_for_status()
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # Check search results
        results = soup.select('.c-tabs-item__content .post-title h3 a')
        if not results:
            return None
            
        for a_tag in results:
            if title.lower() == a_tag.text.strip().lower():
                return a_tag['href']
                
        return results[0]['href'] if results[0].has_attr('href') else None
    except Exception as e:
        print(f"Error searching for {title}: {e}")
        return None

def search_ddg_fallback(title):
    try:
        from ddgs import DDGS
    except ImportError:
        print("  -> ERROR: duckduckgo-search package not installed.")
        return None

    query = f"{title} manhwa site:mangaread.org"
    print(f"\n  [Phase 2] DuckDuckGo Fallback Engine Activated")
    print(f"    -> Querying internet securely for: '{query}'")
    
    try:
        # Enforce 15s timeout
        with DDGS(timeout=15) as ddgs:
            results = list(ddgs.text(query, max_results=5))
            if not results:
                print("    -> Zero links found on DuckDuckGo (Or DDG blocked the request).")
                return None
            for idx, result in enumerate(results, start=1):
                url = result.get('href', '')
                print(f"       Evaluating DDG Result #{idx}: {url}")
                if "mangaread.org/manga/" in url:
                    match = re.match(r'(https?://(?:www\.)?mangaread\.org/manga/[^/]+/)', url)
                    if match:
                        print(f"    -> [SUCCESS] Perfect comic page extracted!")
                        return match.group(1)
            print("    -> None of the top 5 links pointed to a proper comic.")
            return None
    except Exception as e:
        print(f"    -> DuckDuckGo connection failed or timed out: {e}")
        return None

def search_direct_slug(title):
    """Bypasses search engines entirely and maps directly to the URL based on title."""
    print(f"\n  [Phase 2.5] Direct Mathematical Translation Activated")
    slug = re.sub(r'[^a-z0-9\s-]', '', title.lower()).strip()
    slug = re.sub(r'\s+', '-', slug)
    url = f"https://www.mangaread.org/manga/{slug}/"
    print(f"    -> Generated direct URL link: {url}")
    return url

def fetch_manga_details(url):
    """Fetches details from the manga's specific page."""
    try:
        res = requests.get(url, headers=HEADERS, timeout=10)
        res.raise_for_status()
        soup = BeautifulSoup(res.text, 'html.parser')

        # Extract details robustly
        
        # Title
        on_page_title = ""
        title_block = soup.select_one('.post-title h1')
        if title_block:
            on_page_title = title_block.text.strip().replace('HOT', '').strip()
            
        # Author
        author_element = soup.select_one('.author-content a')
        author = author_element.text.strip() if author_element else ""

        # Genres
        genre_elements = soup.select('.genres-content a')
        genres = ", ".join([a.text.strip() for a in genre_elements])

        # Image
        image_element = soup.select_one('.summary_image img')
        image = ""
        if image_element:
            image = image_element.get('src', '')
            if not image or image.startswith('data:image'):
                image = image_element.get('data-src', image)

        # Description
        desc_element = soup.select_one('.summary__content')
        description = desc_element.text.strip() if desc_element else ""
        
        # Rating
        score = soup.select_one('#averagerate') or soup.select_one('.score')
        votes = soup.select_one('#countrate') or soup.select_one('.vote-count')
        score_val = score.text.strip() if score else "?"
        votes_val = votes.text.strip() if votes else "?"
        rating = f"{score_val}/5 ({votes_val} votes)"
        
        # Alternative Names
        alt_name = ""
        for block in soup.select('.post-content_item'):
            heading = block.select_one('.summary-heading h5')
            if heading and 'Alternative' in heading.text:
                content_block = block.select_one('.summary-content')
                if content_block:
                    alt_name = content_block.text.strip()
                    break
        
        return {
            "Title": on_page_title,
            "Author": author,
            "Genre": genres,
            "Image": image,
            "Description": description,
            "Manga URL": url,
            "Rating": rating,
            "Alternative Names": alt_name
        }
    except Exception as e:
        print(f"Error fetching details from {url}: {e}")
        return None

def main():
    print(f"Loading {INPUT_FILE}...")
    try:
        wb = load_workbook(INPUT_FILE)
        ws = wb.active
    except Exception as e:
        print(f"Failed to load workbook: {e}")
        return

    headers_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True))
    headers_list = list(headers_row)
    
    if 'Manga URL' not in headers_list:
        headers_list.append('Manga URL')
        ws.cell(row=1, column=len(headers_list)).value = 'Manga URL'
    if 'Rating' not in headers_list:
        headers_list.append('Rating')
        ws.cell(row=1, column=len(headers_list)).value = 'Rating'
    if 'Alternative Names' not in headers_list:
        headers_list.append('Alternative Names')
        ws.cell(row=1, column=len(headers_list)).value = 'Alternative Names'

    col_idx = {name: idx + 1 for idx, name in enumerate(headers_list) if name}
    
    # Ensure necessary columns exist
    required_cols = ['English', 'Image', 'Genre', 'Author', 'Description', 'Manga URL', 'Rating']
    for col in required_cols:
        if col not in col_idx:
            print(f"Error: Could not find '{col}' in headers: {headers_list}")
            return
            
    print(f"Column mapping: {col_idx}")

    # Process each row (skip header)
    for row in range(2, ws.max_row + 1):
        title = ws.cell(row=row, column=col_idx['English']).value
        
        # Skip empty rows
        # Skip empty rows
        if not title or title == '':
            continue
            
        # Avoid processing items that already have data
        if ws.cell(row=row, column=col_idx.get('Manga URL', 999)).value or ws.cell(row=row, column=col_idx.get('Image', 999)).value:
            print(f"Skipping row {row}: {title} (Already Populated)")
            continue
            
        print(f"\n=======================================================")
        print(f"Processing row {row}: {title}")
        print(f"=======================================================")
        print(f"  [Phase 1] Checking Mangaread Native Search Database...")
        
        manga_url = search_manga(title)
        details = None
        if manga_url:
            print(f"    -> [SUCCESS] Found natively without fallback: {manga_url}")
            details = fetch_manga_details(manga_url)
            
        if not details or not details.get('Description'):
            print(f"  -> Native search failed or returned empty data (Likely punctation/typo).")
            print(f"  [Phase 2] Handing over to DuckDuckGo Fallback...")
            fb_url = search_ddg_fallback(title)
            if fb_url:
                print(f"  [Phase 3] Found via DDG. Scraping new data from: {fb_url}")
                details = fetch_manga_details(fb_url)
                
            # Final mathematically guaranteed fallback since search engines are blocking Python right now!
            if not fb_url or not details or not details.get('Description'):
                print(f"  -> DuckDuckGo failed or timed out (IP is shadow-banned from scraping today).")
                direct_url = search_direct_slug(title)
                print(f"  [Phase 3] Scraping new data from guaranteed direct link: {direct_url}")
                details = fetch_manga_details(direct_url)
                        
        if details and (details.get('Description') or details.get('Image')):
            print(f"    -> Title fetched: '{details.get('Title')}'")
            # Validation Gate
            is_match = False
            excel_t = re.sub(r'[^a-zA-Z0-9]', '', title.lower())
            found_t = re.sub(r'[^a-zA-Z0-9]', '', details.get('Title', '').lower())
            
            if excel_t in found_t or found_t in excel_t:
                is_match = True
                
            if not is_match and details.get('Alternative Names'):
                alt_names = details['Alternative Names'].split(',')
                for alt in alt_names:
                    alt_clean = re.sub(r'[^a-zA-Z0-9]', '', alt.strip().lower())
                    if excel_t in alt_clean or alt_clean in excel_t:
                        is_match = True
                        break
                        
            if not is_match:
                ratio = difflib.SequenceMatcher(None, excel_t, found_t).ratio()
                if ratio > 0.8:
                    is_match = True
                    
            if not is_match:
                print(f"  [REJECTED] Found manga '{details.get('Title')}' differs dramatically from '{title}'.")
                print(f"  -> Skipping to avoid corrupting sheet with wrong link!")
                continue

            print(f"\n  [Phase 4] Generating Excel Column Writes...")
            # Update cells only if they have data
            if details['Image'] and not ws.cell(row=row, column=col_idx['Image']).value:
                ws.cell(row=row, column=col_idx['Image']).value = details['Image']
                print(f"    + Added Image")
            if details['Genre'] and not ws.cell(row=row, column=col_idx['Genre']).value:
                ws.cell(row=row, column=col_idx['Genre']).value = details['Genre']
                print(f"    + Added Genre")
            if details['Author'] and not ws.cell(row=row, column=col_idx['Author']).value:
                ws.cell(row=row, column=col_idx['Author']).value = details['Author']
                print(f"    + Added Author")
            if details['Description'] and not ws.cell(row=row, column=col_idx['Description']).value:
                ws.cell(row=row, column=col_idx['Description']).value = details['Description']
                print(f"    + Added Description")
            if details.get('Manga URL'):
                ws.cell(row=row, column=col_idx['Manga URL']).value = details['Manga URL']
                print(f"    + Added Manga URL")
            if details.get('Rating') and details['Rating'] != "?/5 (? votes)":
                ws.cell(row=row, column=col_idx['Rating']).value = details['Rating']
                print(f"    + Added Rating")
            if details.get('Alternative Names'):
                ws.cell(row=row, column=col_idx['Alternative Names']).value = details['Alternative Names']
                print(f"    + Added Alternative Names")
        else:
             print(f"  -> Failed to parse details from both sources.")
             
        time.sleep(1)  # Rate limiting
        
    print(f"Saving changes to {OUTPUT_FILE}...")
    wb.save(OUTPUT_FILE)
    print("Done!")

if __name__ == '__main__':
    main()
