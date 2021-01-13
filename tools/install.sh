#!/bin/bash

if [ "$(uname)" == "Darwin" ]; then
    # mac
    echo "Mac"
else
    yay -S npm
fi

sudo pip3 install staticjinja
