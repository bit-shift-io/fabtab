#!/usr/bin/env python3

import os.path, os
from ftplib import FTP, error_perm
from getpass import getpass
import sys

if (len(sys.argv) == 3):
    username = sys.argv[1]
    password = sys.argv[2]
else:
    username = input("Username:")
    password = getpass()

ftp = FTP('ftpupload.net')
ftp.login(username, password)
ftp.cwd('htdocs') 

filenameCV = "../public"

def placeFiles(ftp, path):
    for name in os.listdir(path):
        localpath = os.path.join(path, name)
        if os.path.isfile(localpath):
            print("STOR", name, localpath)
            ftp.storbinary('STOR ' + name, open(localpath,'rb'))
        elif os.path.isdir(localpath):
            print("MKD", name)

            try:
                ftp.mkd(name)

            # ignore "directory already exists"
            except error_perm as e:
                if not e.args[0].startswith('550'): 
                    raise

            print("CWD", name)
            ftp.cwd(name)
            placeFiles(ftp, localpath)           
            print("CWD", "..")
            ftp.cwd("..")

placeFiles(ftp, filenameCV)

ftp.quit()