import os
import json
from dotenv import load_dotenv
from supabase import create_client

# Load the exact same .env keys the Desktop App relies on
load_dotenv('.env')

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
# Writing scraper_configs needs the secret key (sb_secret_...): the table has
# no write policy for the publishable key. The secret key bypasses row-level
# security, so it lives only in the root .env and is never printed.
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")
SUPABASE_KEY = SUPABASE_SECRET_KEY or os.getenv("SUPABASE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Error: Missing Supabase keys in .env")
    exit(1)

if not SUPABASE_SECRET_KEY:
    print("Warning: SUPABASE_SECRET_KEY is not set; using SUPABASE_KEY. "
          "Writes to scraper_configs will likely be rejected by row-level security.")

client = create_client(SUPABASE_URL, SUPABASE_KEY)

SCRAPERS_DIR = "scrapers"

def push_scrapers():
    print(f"Connecting to Supabase: {SUPABASE_URL}")
    for filename in os.listdir(SCRAPERS_DIR):
        if filename.endswith(".json"):
            file_path = os.path.join(SCRAPERS_DIR, filename)
            
            with open(file_path, "r", encoding="utf-8") as f:
                json_data = json.load(f)
                website_name = json_data.get("name", filename.replace(".json", ""))
                
                print(f"Uploading config for: {website_name} ...")
                
                # Check if it exists to avoid Unique Constraint errors if UPSERT isn't configured
                existing = client.table("scraper_configs").select("website_name").eq("website_name", website_name).execute()
                
                if existing.data:
                    # Update
                    client.table("scraper_configs").update({"json_rules": json_data}).eq("website_name", website_name).execute()
                    print(f"    -> Updated successfully!")
                else:
                    # Insert
                    client.table("scraper_configs").insert({
                        "website_name": website_name,
                        "json_rules": json_data
                    }).execute()
                    print(f"    -> Inserted successfully!")
                    
    print("\nAll JSON configurations are successfully live on your Cloud!")

if __name__ == "__main__":
    push_scrapers()
