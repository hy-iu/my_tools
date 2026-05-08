import os
import json

# 获取图片列表
imgs = ["cropped/" + f for f in os.listdir("cropped") if f.lower().endswith((".jpg", ".jpeg", ".png"))]
imgs_json = json.dumps(imgs)

html_content = f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>原尺寸分步滑动相册 - 高级版</title>
    <style>
        body, html {{ 
            margin: 0; 
            padding: 0; 
            height: 100%; 
            background: #000; 
            color: #fff; 
            font-family: system-ui; 
            overflow: hidden; 
        }}

        .viewport {{
            width: 100vw;
            height: 100vh;
            overflow-x: auto;
            overflow-y: auto; /* 允许纵向滚动以防图片太高 */
            display: block;
            scroll-behavior: smooth;
            scrollbar-width: thin;
            scrollbar-color: #444 #000;
        }}

        .track {{
            display: flex;
            width: max-content;
            align-items: flex-start; /* 顶部对齐 */
        }}

        .track img {{
            /* 绝对原尺寸的核心设置 */
            flex: 0 0 auto; /* 禁止压缩 */
            width: auto !important;
            height: auto !important;
            display: block;
            margin: 0;
            padding: 0;
            /* 移除之前限制高度的 max-height */
        }}

        .controls {{
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(255, 255, 255, 0.95);
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            z-index: 1000;
            color: #333;
            display: flex;
            flex-direction: column;
            gap: 15px;
            width: 220px;
        }}

        .control-group {{
            display: flex;
            flex-direction: column;
            gap: 5px;
        }}

        label {{
            font-size: 13px;
            font-weight: bold;
            color: #555;
        }}

        input[type="range"] {{
            width: 100%;
            cursor: pointer;
        }}

        button {{
            cursor: pointer;
            padding: 12px;
            background: #007AFF;
            color: white;
            border: none;
            border-radius: 8px;
            font-weight: bold;
            font-size: 14px;
            transition: background 0.2s;
        }}

        button:hover {{
            background: #0056b3;
        }}

        .hints {{
            position: fixed;
            bottom: 20px;
            left: 20px;
            background: rgba(0,0,0,0.6);
            padding: 8px 15px;
            border-radius: 20px;
            font-size: 12px;
            pointer-events: none;
        }}
    </style>
</head>
<body>
    <div class="controls">
        <button id="playBtn" onclick="togglePlay()">自动播放: 运行中</button>
        
        <div class="control-group">
            <label>停留时间: <span id="pauseVal">3</span> 秒</label>
            <input type="range" min="1" max="10" value="3" step="0.5" oninput="updatePause(this.value)">
        </div>

        <div class="control-group">
            <label>单次滑动张数: <span id="stepVal">4</span> 张</label>
            <input type="range" min="1" max="10" value="4" oninput="updateStep(this.value)">
        </div>
    </div>

    <div class="hints">图片以原始像素显示。如果图片高于屏幕，可纵向滚动。</div>

    <div class="viewport" id="viewport">
        <div class="track" id="track"></div>
    </div>

    <script>
        const images = {imgs_json};
        const viewport = document.getElementById('viewport');
        const track = document.getElementById('track');
        const playBtn = document.getElementById('playBtn');
        
        let currentIndex = 0;
        let isPlaying = true;
        let timer = null;
        
        // 动态参数
        let pauseTime = 3000;
        let stepCount = 4;

        function init() {{
            track.innerHTML = images.map(src => `<img src="${{src}}" onload="checkLoad(this)">`).join('');
        }}

        function updatePause(val) {{
            pauseTime = val * 1000;
            document.getElementById('pauseVal').innerText = val;
        }}

        function updateStep(val) {{
            stepCount = parseInt(val);
            document.getElementById('stepVal').innerText = val;
        }}

        let loadedCount = 0;
        function checkLoad(img) {{
            loadedCount++;
            // 当第一屏图片加载完就开始滑动
            if (loadedCount === 1 && isPlaying) {{
                scheduleNext();
            }}
        }}

        async function autoScroll() {{
            if (!isPlaying) return;

            const imgs = track.getElementsByTagName('img');
            if (currentIndex >= imgs.length) {{
                currentIndex = 0;
                viewport.scrollLeft = 0;
                scheduleNext();
                return;
            }}

            let scrollDistance = 0;
            const targetIndex = Math.min(currentIndex + stepCount, imgs.length);
            
            for (let i = currentIndex; i < targetIndex; i++) {{
                scrollDistance += imgs[i].offsetWidth;
            }}

            viewport.scrollBy({{ left: scrollDistance, behavior: 'smooth' }});
            currentIndex = targetIndex;

            if (currentIndex >= imgs.length) {{
                setTimeout(() => {{
                    viewport.scrollTo({{ left: 0, behavior: 'auto' }});
                    currentIndex = 0;
                    scheduleNext();
                }}, pauseTime);
            }} else {{
                scheduleNext();
            }}
        }}

        function scheduleNext() {{
            clearTimeout(timer);
            timer = setTimeout(autoScroll, pauseTime);
        }}

        function togglePlay() {{
            isPlaying = !isPlaying;
            playBtn.innerText = isPlaying ? "自动播放: 运行中" : "自动播放: 已暂停";
            playBtn.style.background = isPlaying ? "#007AFF" : "#555";
            if (isPlaying) scheduleNext();
            else clearTimeout(timer);
        }}

        init();
        
        // 允许手动干预但不完全停止
        viewport.addEventListener('wheel', () => {{
            // 用户滚动时暂时停止一下计时，避免冲突
            clearTimeout(timer);
            if (isPlaying) timer = setTimeout(autoScroll, pauseTime + 2000);
        }}, {{passive: true}});
    </script>
</body>
</html>
"""

with open("viewer.html", "w", encoding="utf-8") as f:
    f.write(html_content)
print("viewer.html updated with original size and speed controls.")
