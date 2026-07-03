.PHONY: pdf clean

# latexmk runs pdflatex as often as necessary for the table of contents and
# cross-references. Auxiliary files go to build/ through .latexmkrc.
pdf:
	latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex

clean:
	latexmk -c main.tex

