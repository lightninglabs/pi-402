# Makefile for the pi-402 talk.
# Usage: make / make pdf / make pages / make clean

MAIN = main
TEX = pdflatex
FLAGS = -interaction=nonstopmode -halt-on-error

.PHONY: all pdf clean pages

all: pdf

pdf: $(MAIN).pdf

$(MAIN).pdf: $(MAIN).tex
	$(TEX) $(FLAGS) $(MAIN).tex
	$(TEX) $(FLAGS) $(MAIN).tex  # Run twice so the frame count resolves.

# Render every slide to a PNG under pages/ for visual review.
pages: $(MAIN).pdf
	@mkdir -p pages
	pdftoppm -png -r 110 $(MAIN).pdf pages/slide

clean:
	rm -f *.aux *.log *.nav *.out *.snm *.toc *.vrb
