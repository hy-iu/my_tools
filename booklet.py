from PyPDF2 import PdfReader, PdfWriter, Transformation, PageObject
import math
import os

def create_booklet(input_path, output_path):
    reader = PdfReader(input_path)
    total_pages = len(reader.pages)

    booklet_pages = math.ceil(total_pages / 4) * 4
    # print(f"总页数: {total_pages}, 小册子页数: {booklet_pages}")

    writer = PdfWriter()

    w = reader.pages[0].mediabox.width
    h = reader.pages[0].mediabox.height
    transform = Transformation().translate(w, 0)
    # print(f"页面尺寸: {w} x {h}")
    for i in range(booklet_pages // 2):
        if i % 2 == 0:
            left_pos, right_pos = booklet_pages - i - 1, i
        else:
            left_pos, right_pos = i, booklet_pages - i - 1
        new_page = PageObject.create_blank_page(width=w*2, height=h)
        if left_pos < total_pages:
            left_page = reader.pages[left_pos]
            assert left_page.mediabox.width == w and left_page.mediabox.height == h, f"{input_path} 页 {left_pos} 尺寸不匹配"
            new_page.merge_page(left_page)
        if right_pos < total_pages:
            right_page = reader.pages[right_pos]
            assert right_page.mediabox.width == w and right_page.mediabox.height == h, f"{input_path} 页 {right_pos} 尺寸不匹配"
            new_right_page = PageObject.create_blank_page(width=w*2, height=h)
            new_right_page.merge_page(right_page)
            new_right_page.add_transformation(transform)
            new_page.merge_page(new_right_page)
        writer.add_page(new_page)
    with open(output_path, "wb") as f:
        writer.write(f)

if __name__ == "__main__":
    for filename in os.listdir("."):
        if filename.endswith(".pdf") and not filename.endswith("_let.pdf"):
            output_filename = filename.replace(".pdf", "_let.pdf")
            create_booklet(filename, output_filename)
            # print(f"已创建小册子: {output_filename}")