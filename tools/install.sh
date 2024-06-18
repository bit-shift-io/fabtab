#!/bin/bash

if [ "$(uname)" == "Darwin" ]; then
    # mac
    echo "Mac"
    #brew install python
    pip3 install staticjinja --user --break-system-packages
else
    # linux
    yay -S npm
    sudo pip3 install staticjinja
fi
