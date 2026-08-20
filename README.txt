Put your photographs here.

The project pages look for these filenames:
  sophy-house.jpg
  maweni-kigamboni.jpg
  kunduchi.jpg
  shamo.jpg
  kigamboni-site.jpg
  hql-offices.jpg
  meatix.jpg
  bongo-lodge.jpg
  interior.jpg

Resize to 1600px on the long edge, save as JPEG at ~80% quality
(roughly 200-400 KB each). Then in the HTML replace:

  <div class="ph"><i data-en="sophy-house.jpg" ...>sophy-house.jpg</i></div>

with:

  <div class="ph"><img src="images/sophy-house.jpg"
       alt="Sophy House" loading="lazy" width="800" height="600"></div>
