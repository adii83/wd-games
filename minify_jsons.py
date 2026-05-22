import json
from pathlib import Path

def minify_json_file(file_path: Path):
    if not file_path.exists():
        print(f"File {file_path} tidak ditemukan. Dilewati.")
        return
        
    original_size = file_path.stat().st_size
    print(f"Memproses {file_path.name}... (Ukuran awal: {original_size / 1024:.2f} KB)")
    
    try:
        with file_path.open('r', encoding='utf-8') as f:
            data = json.load(f)
            
        with file_path.open('w', encoding='utf-8') as f:
            json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
            
        new_size = file_path.stat().st_size
        saved_bytes = original_size - new_size
        saved_percent = (saved_bytes / original_size) * 100
        print(f"Selesai! Ukuran baru: {new_size / 1024:.2f} KB (Hemat {saved_bytes / 1024:.2f} KB / {saved_percent:.1f}%)")
    except Exception as e:
        print(f"Error saat memproses {file_path.name}: {e}")

def main():
    workspace_dir = Path(__file__).parent
    files_to_minify = [
        workspace_dir / "ps2.json",
        workspace_dir / "steamrip_games_updated.json"
    ]
    
    for file_path in files_to_minify:
        minify_json_file(file_path)

if __name__ == "__main__":
    main()
