Original: https://gemini.google.com/app/444e87898dcfed9b

To remember: 

# unsplash-images-collection
# unsplash-images-collection-mini
# unsplash-images-collection-micro

nice --10 node src/train.js ./datasets/unsplash-images-collection --discover=20 --bootstrap=10 --reprobe=5

node src/train.js ./datasets/unsplash-images-collection --evaluate

## Desktop

node src/train.js ./datasets/pinterest_images --discover=10 --bootstrap=50 --reprobe=25