from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time
import logging
import os
from bs4 import BeautifulSoup
import requests
from threading import Thread
import re

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

# Disable webdriver_manager logging
logging.getLogger('WDM').setLevel(logging.CRITICAL)

# Configurable parameters
num_cycles = 25
wait_time_in_tab = 60  # seconds
sleep_between_cycles = 0  # seconds
max_tab_execution_time = 50  # maximum time to wait for each tab in seconds

# Create a directory to store user data directories
user_data_dir_base = os.path.join(os.getcwd(), 'user_data_dirs')
os.makedirs(user_data_dir_base, exist_ok=True)

url = 'https://www.dailymotion.com/playlist/x8iuca'

success_count = 0
failure_count = 0

# Function to fetch a list of proxy servers
def get_proxy_list():
    try:
        response = requests.get("https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=ipport&format=text&anonymity=Elite&timeout=20000")
        response.raise_for_status()  # Raise an exception for bad status codes
        return response.text.splitlines()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching proxy list: {str(e)}")
        return []  # Return an empty list if the fetch fails

# Function to handle each tab execution with a timeout and proxy
def handle_tab_execution(url, user_data_dir, cycle_index, proxy):
    global success_count, failure_count

    options = webdriver.ChromeOptions()
    options.add_argument(f"--user-data-dir={user_data_dir}")
    options.add_argument('--no-sandbox')  # Bypass OS security model
    options.add_argument('--disable-dev-shm-usage')  # Overcome limited resource problems

    # Set the proxy for the WebDriver
    if proxy:
        options.add_argument(f'--proxy-server={proxy}')
        logger.info(f"Tab ({cycle_index}/{num_cycles}) using proxy: {proxy}")
    else:
        logger.info(f"Tab ({cycle_index}/{num_cycles}) not using any proxy.")

    try:
        if url:
            driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
            driver.get(url)  # Open the URL
            time.sleep(wait_time_in_tab)  # Wait for the specified time in each tab
        else:
            logger.error("Failed to fetch a valid video URL.")
            failure_count += 1
    except Exception as e:
        failure_count += 1
        logger.error(f"Tab ({cycle_index}/{num_cycles}) failed.")
    finally:
        if 'driver' in locals():
            driver.quit()  # Quit the WebDriver

# Get the list of proxy servers
proxy_list = get_proxy_list()
# 創建一個變數來追蹤目前使用的代理索引
current_proxy_index = 0

try:
    for i in range(1, num_cycles + 1):
        logger.info(f"Opening tab ({i}/{num_cycles})...")

        # Generate a unique user data directory for each tab
        user_data_dir = os.path.join(user_data_dir_base, f"profile_{i}")

        # 確保代理索引不超過代理清單長度
        current_proxy_index = current_proxy_index % len(proxy_list)

        # Get a proxy from the list, excluding ports 80, 8080, and 3128
        proxy = None
        while proxy is None and current_proxy_index < len(proxy_list): 
            candidate_proxy = proxy_list[current_proxy_index]
            port = int(candidate_proxy.split(":")[1])
            if port not in [8080, 80, 3128, 25239, 9002, 16897, 17805, 9090, 8888, 8452, 19045, 55443, 23737, 32929, 1885, 8197, 20669, 9999, 2087, 4444, 10230, 7411, 32650, 9443, 1003, 3000, 28911, 26997, 19999, 27135, 6889, 11222, 999, 18219, 10011, 21377]:
                proxy = candidate_proxy
            current_proxy_index += 1  #  移動到下一個代理

        thread = Thread(target=handle_tab_execution, args=(url, user_data_dir, i, proxy))
        thread.start()
        thread.join(timeout=max_tab_execution_time)  # Wait for the thread to complete or timeout

        if thread.is_alive():
            logger.info(f"Tab ({i}/{num_cycles}) successfully completed.")
            success_count += 1
            # The thread is still running, we need to clean up
            del thread

        time.sleep(sleep_between_cycles)  # Wait specified time between each tab cycle

    logger.info(f"Script completed. Successfully completed: {success_count} tabs. Failed: {failure_count} tabs.")

finally:
    #  我們不刪除 user data directories 了
    pass 