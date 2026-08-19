import os
import glob
from tqdm import tqdm
import subprocess
import shutil

def process_m4s_file(file_path, suffix=".mp4"):
    with open(file_path, 'rb') as file:
        first_nine_chars = file.read(9)
        if first_nine_chars == b'000000000':
            remaining_content = file.read()
            content = remaining_content
            # 将修改后的内容写回文件
            with open(file_path[:-4] + suffix, 'wb') as new_file:
                new_file.write(content)
            return file_path[:-4] + suffix
        else:
            print(f"文件 {file_path} 不是一个有效的m4s文件")
            return file_path

def merge_mp4_mp3(mp4_path, mp3_path, output_path):
    # 使用ffmpeg直接合并音视频
    cmd = [
        # "ffmpeg",
        r"C:\Users\hy-wu.DESKTOP-G355NC5\AppData\Roaming\bilibili\ffmpeg\ffmpeg.exe",
        "-y",  # 覆盖输出文件
        "-i", mp4_path,
        "-i", mp3_path,
        "-c:v", "copy",
        "-c:a", "aac",
        "-strict", "experimental",
        "-map", "0:v:0",
        "-map", "1:a:0",
        output_path
    ]
    subprocess.run(cmd, check=True)

def process(directory, mp4name):
    m4s_files = glob.glob(os.path.join(directory, '*.m4s'))
    # assert len(m4s_files) == 2, f"文件夹 {directory} 下的m4s文件数量不等于2"
    if len(m4s_files) != 2:
        print(f"文件夹 {directory} 下的m4s文件数量不等于2，跳过处理")
        return
    m4s_files = sorted(m4s_files, key=lambda x: os.path.getsize(x))
    mp3 = process_m4s_file(m4s_files[0], ".mp3")
    mp4 = process_m4s_file(m4s_files[1], ".mp4")
    output_file = f"{mp4name}.mp4"
    merge_mp4_mp3(mp4, mp3, output_file)
    # os.remove(mp3)
    # os.remove(mp4)
    return output_file
    
if __name__ == '__main__':
    # dirs = [directory for directory in dirs if os.path.isdir(directory) and directory != "__pycache__" and directory+".mp4" not in dirs]
    dirs = []
    print("安卓格式的bilibili缓存...")
    for directory in os.listdir():
        if os.path.isdir(directory) and directory != "__pycache__" and directory + ".mp4" not in os.listdir():
            for subdir in os.listdir(directory):
                    assert os.path.isdir(os.path.join(directory, subdir)), f"{os.path.join(directory, subdir)} 不是文件夹"
                    for subsubdir in os.listdir(os.path.join(directory, subdir)):
                        # if subsubdir in ["danmaku.xml", "entry.json", "cover.jpg", "danmaku.pb"]:
                        if not os.path.isdir(os.path.join(directory, subdir, subsubdir)):
                            continue
                        assert os.path.isdir(os.path.join(directory, subdir, subsubdir)), f"{os.path.join(directory, subdir, subsubdir)} 不是文件夹"
                        # assert "audio.m4s" in os.listdir(os.path.join(directory, subdir, subsubdir)), f"{os.path.join(directory, subdir, subsubdir)} 下没有 audio.m4s 文件"
                        if not "video.m4s" in os.listdir(os.path.join(directory, subdir, subsubdir)):
                            print(f"{os.path.join(directory, subdir, subsubdir)} 下没有 video.m4s 文件")
                        dirs.append(os.path.join(directory, subdir, subsubdir))
    root = os.getcwd()
    for directory in tqdm(dirs):
        filename = process(os.path.join(root, directory), directory.replace("\\", "_").replace("/", "_"))
        if filename:
            shutil.move(os.path.join(root, filename), os.path.join("D:\\bilibili", os.path.basename(filename)))
