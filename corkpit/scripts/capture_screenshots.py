import asyncio
import os
import subprocess
import time
from playwright.async_api import async_playwright
from PIL import Image, ImageDraw, ImageFilter

OUTPUT_DIR = r"C:\Users\hy-wu.DESKTOP-G355NC5\Projects\my_tools\corkpit\docs\images"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def beautify_screenshot(raw_image_path, output_path, title="Cockpit · Multi-Agent Control"):
    # Load raw image
    img = Image.open(raw_image_path).convert("RGBA")
    w, h = img.size

    # Window title bar dimensions
    title_bar_height = 42
    border_radius = 16
    padding = 40  # surrounding canvas padding for shadow & gradient bg

    # New image size with titlebar
    framed_w = w
    framed_h = h + title_bar_height

    framed = Image.new("RGBA", (framed_w, framed_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(framed)

    # Rounded rectangle for entire window container
    # Draw background
    window_bg = (13, 17, 23, 255) # Dark GitHub / Cockpit style
    header_bg = (22, 27, 34, 255)
    border_color = (48, 54, 61, 255)

    # Create mask for rounded corners
    mask = Image.new("L", (framed_w, framed_h), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, framed_w, framed_h], radius=border_radius, fill=255)

    # Draw header
    header_img = Image.new("RGBA", (framed_w, framed_h), window_bg)
    header_draw = ImageDraw.Draw(header_img)
    header_draw.rectangle([0, 0, framed_w, title_bar_height], fill=header_bg)
    header_draw.line([(0, title_bar_height), (framed_w, title_bar_height)], fill=border_color, width=1)

    # Draw macOS / window control dots
    dot_radius = 6
    dot_y = title_bar_height // 2
    dots = [
        (24, dot_y, (255, 95, 86, 255)),   # Red
        (44, dot_y, (255, 189, 46, 255)),  # Yellow
        (64, dot_y, (39, 201, 63, 255)),   # Green
    ]
    for dx, dy, color in dots:
        header_draw.ellipse([dx - dot_radius, dy - dot_radius, dx + dot_radius, dy + dot_radius], fill=color)

    # Paste the captured web screenshot below the header
    header_img.paste(img, (0, title_bar_height))

    # Apply rounded mask
    rounded_window = Image.new("RGBA", (framed_w, framed_h), (0, 0, 0, 0))
    rounded_window.paste(header_img, (0, 0), mask=mask)

    # Draw window border
    border_overlay = Image.new("RGBA", (framed_w, framed_h), (0, 0, 0, 0))
    b_draw = ImageDraw.Draw(border_overlay)
    b_draw.rounded_rectangle([0, 0, framed_w - 1, framed_h - 1], radius=border_radius, outline=border_color, width=1)
    rounded_window = Image.alpha_composite(rounded_window, border_overlay)

    # Create final canvas with soft glow / drop shadow and subtle dark background
    canvas_w = framed_w + padding * 2
    canvas_h = framed_h + padding * 2
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))

    # Draw soft drop shadow
    shadow_mask = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    s_draw = ImageDraw.Draw(shadow_mask)
    shadow_offset_y = 12
    s_draw.rounded_rectangle(
        [padding, padding + shadow_offset_y, padding + framed_w, padding + framed_h + shadow_offset_y],
        radius=border_radius + 4,
        fill=(0, 0, 0, 160)
    )
    shadow_blurred = shadow_mask.filter(ImageFilter.GaussianBlur(radius=24))

    # Composite shadow and window
    canvas = Image.alpha_composite(canvas, shadow_blurred)
    canvas.paste(rounded_window, (padding, padding), mask=rounded_window)

    # Save beautified image
    canvas.save(output_path, "PNG", optimize=True)
    print(f"Saved beautified screenshot to {output_path}")

async def capture_all():
    # Start server
    proc = subprocess.Popen(
        ["node", "dist/cli.js", "serve", "--port", "4177"],
        cwd=r"C:\Users\hy-wu.DESKTOP-G355NC5\Projects\my_tools\corkpit",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    time.sleep(2)

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            # Use high DPI (device_scale_factor=2) and 1440x960 viewport
            context = await browser.new_context(
                viewport={"width": 1400, "height": 900},
                device_scale_factor=2
            )
            page = await context.new_page()

            print("Navigating to Cockpit UI...")
            await page.goto("http://127.0.0.1:4177/", wait_until="networkidle")
            await asyncio.sleep(1.5)

            # 1. Mission Control
            raw_mc = os.path.join(OUTPUT_DIR, "_raw_mission_control.png")
            mc_out = os.path.join(OUTPUT_DIR, "mission-control.png")
            await page.screenshot(path=raw_mc, full_page=False)
            beautify_screenshot(raw_mc, mc_out, "Cockpit · Mission Control")

            # 2. Cost Flow
            await page.click('button[data-view="cost"]')
            await asyncio.sleep(1.0)
            raw_cf = os.path.join(OUTPUT_DIR, "_raw_cost_flow.png")
            cf_out = os.path.join(OUTPUT_DIR, "cost-flow.png")
            await page.screenshot(path=raw_cf, full_page=False)
            beautify_screenshot(raw_cf, cf_out, "Cockpit · Cost Flow")

            # 3. Skills & MCP
            await page.click('button[data-view="capabilities"]')
            await asyncio.sleep(1.0)
            raw_mcp = os.path.join(OUTPUT_DIR, "_raw_skills_mcp.png")
            mcp_out = os.path.join(OUTPUT_DIR, "skills-mcp.png")
            await page.screenshot(path=raw_mcp, full_page=False)
            beautify_screenshot(raw_mcp, mcp_out, "Cockpit · Skills & MCP")

            # 4. Adapters
            await page.click('button[data-view="adapters"]')
            await asyncio.sleep(1.0)
            raw_ad = os.path.join(OUTPUT_DIR, "_raw_adapters.png")
            ad_out = os.path.join(OUTPUT_DIR, "adapters.png")
            await page.screenshot(path=raw_ad, full_page=False)
            beautify_screenshot(raw_ad, ad_out, "Cockpit · Adapters")

            # Clean raw files
            for raw in [raw_mc, raw_cf, raw_mcp, raw_ad]:
                if os.path.exists(raw):
                    os.remove(raw)

            await browser.close()
    finally:
        proc.terminate()

if __name__ == "__main__":
    asyncio.run(capture_all())
