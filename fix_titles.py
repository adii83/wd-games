import json
import re
import traceback

file_path = r"d:\My Project\wd_games\steamrip_games.json"

try:
    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    changed_count = 0
    for item in data:
        if 'title' in item:
            original = item['title']
            # Replace 'Free Download', ignoring case just in case, and clean up extra spaces
            new_title = re.sub(r'\s*Free Download\s*', ' ', original, flags=re.IGNORECASE)
            # Clean up potentially leftover spaces before brackets or at the end
            new_title = re.sub(r'\s+\(', ' (', new_title)
            new_title = new_title.strip()
            
            if new_title != original:
                item['title'] = new_title
                changed_count += 1

    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

    print(f"Successfully processed {len(data)} items.")
    print(f"Updated {changed_count} titles.")
except Exception as e:
    print("Error occurred:")
    traceback.print_exc()
