# Keep the final PDF beside main.tex while all disposable LaTeX files live in
# report/build. Both the Makefile and VS Code's LaTeX Workshop use this file.
$pdf_mode = 1;
$out_dir = '.';
$aux_dir = 'build';

# Generate build/word-progress.tex immediately before every pdflatex run.
# The script only rewrites the file when the calculated total changes.
$pdflatex = 'python3 scripts/update_word_progress.py && pdflatex %O %S';
