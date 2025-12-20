import os
import paramiko
import getpass

# --- Server Configuration ---
# Replace these with your server's details.
# It's better to use environment variables or a config file for sensitive data.
HOSTNAME = "1ink.us"
PORT = 22  # Default SFTP/SSH port
USERNAME = "ford442"

# The directory on the server where the files should go (e.g., 'public_html/wasm-game').
REMOTE_DIRECTORY = "test.1ink.us/visual6502"

# Create the dist directory if it doesn't exist
os.makedirs('./dist', exist_ok=True)

import shutil
# The local directory to upload from.
LOCAL_DIRECTORY = "dist"
# The directory on the server where the files should go
REMOTE_DIRECTORY = "test.1ink.us/visual6502"

# 1. Clean and Re-create the dist directory
if os.path.exists(LOCAL_DIRECTORY):
    shutil.rmtree(LOCAL_DIRECTORY)
os.makedirs(LOCAL_DIRECTORY)

src_dir = '.'
dst_dir = LOCAL_DIRECTORY

# 2. Copy specific file types from the root
extensions = ('.html', '.css', '.js', '.json', '.md') # Added .json/.md just in case

for filename in os.listdir(src_dir):
    if filename.endswith(extensions):
        src = os.path.join(src_dir, filename)
        dst = os.path.join(dst_dir, filename)
        shutil.copy2(src, dst)
        print(f"Copied file: {filename}")

# 3. Copy required directories (images, 3rdparty)
directories_to_copy = ['images', '3rdparty']

for item in directories_to_copy:
    src_path = os.path.join(src_dir, item)
    dst_path = os.path.join(dst_dir, item)
    
    if os.path.exists(src_path):
        # copytree requires the destination to NOT exist usually, 
        # but we just cleaned dist so it should be fine.
        shutil.copytree(src_path, dst_path)
        print(f"Copied directory: {item}")

def upload_directory(sftp_client, local_path, remote_path):
    """
    Recursively uploads a directory and its contents to the remote server.
    """
    print(f"Creating remote directory: {remote_path}")
    try:
        # Create the target directory on the server if it doesn't exist.
        sftp_client.mkdir(remote_path)
    except IOError:
        # Directory already exists, which is fine.
        print(f"Directory {remote_path} already exists.")

    for item in os.listdir(local_path):
        local_item_path = os.path.join(local_path, item)
        remote_item_path = f"{remote_path}/{item}"

        if os.path.isfile(local_item_path):
            print(f"Uploading file: {local_item_path} -> {remote_item_path}")
            sftp_client.put(local_item_path, remote_item_path)
        elif os.path.isdir(local_item_path):
            # If it's a directory, recurse into it.
            upload_directory(sftp_client, local_item_path, remote_item_path)

def main():
    """
    Main function to connect to the server and start the upload process.
    """
    password = 'GoogleBez12!' # getpass.getpass(f"Enter password for {USERNAME}@{HOSTNAME}: ")

    transport = None
    sftp = None
    try:
        # Establish the SSH connection
        transport = paramiko.Transport((HOSTNAME, PORT))
        print("Connecting to server...")
        transport.connect(username=USERNAME, password=password)
        print("Connection successful!")

        # Create an SFTP client from the transport
        sftp = paramiko.SFTPClient.from_transport(transport)
        print(f"Starting upload of '{LOCAL_DIRECTORY}' to '{REMOTE_DIRECTORY}'...")

        # Start the recursive upload
        upload_directory(sftp, LOCAL_DIRECTORY, REMOTE_DIRECTORY)

        print("\n✅ Deployment complete!")

    except Exception as e:
        print(f"❌ An error occurred: {e}")
    finally:
        # Ensure the connection is closed
        if sftp:
            sftp.close()
        if transport:
            transport.close()
        print("Connection closed.")

if __name__ == "__main__":
    if not os.path.exists(LOCAL_DIRECTORY):
        print(f"Error: Local directory '{LOCAL_DIRECTORY}' not found. Did you run 'npm run build' first?")
    else:
        main()

