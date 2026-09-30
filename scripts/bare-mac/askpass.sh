#!/bin/sh
# The Cirrus Labs images ship one account, admin/admin. ssh reads the password
# from here (SSH_ASKPASS_REQUIRE=force), so the host needs no sshpass.
echo admin
