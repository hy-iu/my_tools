import os
import cv2
from ultralytics import YOLO

def crop_people(input_dir, output_dir):
    # Load YOLOv8 model (nano version is fast and sufficient for person detection)
    model = YOLO('yolov8n.pt')
    
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        print(f"Created output directory: {output_dir}")

    # Supported image extensions
    valid_extensions = ('.jpg', '.jpeg', '.png', '.webp')
    
    image_files = [f for f in os.listdir(input_dir) if f.lower().endswith(valid_extensions)]
    
    if not image_files:
        print("No image files found in the directory.")
        return

    print(f"Found {len(image_files)} images. Starting processing...")

    for filename in image_files:
        image_path = os.path.join(input_dir, filename)
        
        # Run inference
        results = model(image_path, verbose=False)
        
        # Load image for cropping
        img = cv2.imread(image_path)
        if img is None:
            print(f"Warning: Could not read {filename}. Skipping.")
            continue
            
        h, w = img.shape[:2]
        
        # Filter detections for 'person' (class 0)
        # We'll take the person with the largest bounding box area if multiple are found
        person_boxes = []
        for r in results:
            for box in r.boxes:
                if int(box.cls[0]) == 0: # 0 is the class index for 'person'
                    coords = box.xyxy[0].tolist() # [x1, y1, x2, y2]
                    area = (coords[2] - coords[0]) * (coords[3] - coords[1])
                    person_boxes.append((area, coords))
        
        if not person_boxes:
            print(f"No person detected in {filename}. Skipping.")
            continue
            
        # Sort by area descending and pick the largest one
        person_boxes.sort(key=lambda x: x[0], reverse=True)
        _, best_coords = person_boxes[0]
        
        x1, y1, x2, y2 = best_coords
        
        # Add some padding (e.g., 5% of the width/height)
        pad_w = (x2 - x1) * 0.1
        pad_h = (y2 - y1) * 0.1
        
        x1 = max(0, int(x1 - pad_w))
        y1 = max(0, int(y1 - pad_h))
        x2 = min(w, int(x2 + pad_w))
        y2 = min(h, int(y2 + pad_h))
        
        # Crop and save
        cropped_img = img[y1:y2, x1:x2]
        output_path = os.path.join(output_dir, filename)
        cv2.imwrite(output_path, cropped_img)
        print(f"Processed: {filename} -> {output_path}")

if __name__ == "__main__":
    input_directory = "."  # Current directory
    output_directory = "cropped"
    crop_people(input_directory, output_directory)
