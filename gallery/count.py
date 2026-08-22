import re
import sys
import glob

def count_chinese_characters(file_path):
    # 匹配中文字符的正则表达式（包括基本汉字和扩展汉字）
    chinese_pattern = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\U00020000-\U0002a6df\U0002a700-\U0002b73f\U0002b740-\U0002b81f\U0002b820-\U0002ceaf]')

    count = 0
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            for line in file:
                # 查找每行中的所有中文字符
                matches = chinese_pattern.findall(line)
                count += len(matches)
    except FileNotFoundError:
        print(f"错误：文件 {file_path} 未找到")
        return None
    except Exception as e:
        print(f"发生错误：{e}")
        return None
    return count

assert len(sys.argv) == 2, "请提供一个文件路径或文件模式作为参数"

file_pattern = sys.argv[1]

for file_path in glob.glob(file_pattern, recursive=True):
    count = count_chinese_characters(file_path)
    if count is not None:
        print(f"文件 {file_path} 中的中文字符数量: {count}")
