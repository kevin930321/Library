from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time
import logging
import os
from bs4 import BeautifulSoup
import requests
from threading import Thread

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

# Configurable parameters
num_cycles = 60
wait_time_in_tab = 60  # seconds
sleep_between_cycles = 0  # seconds
max_tab_execution_time = 55  # maximum time to wait for each tab in seconds

# Create a directory to store user data directories
user_data_dir_base = os.path.join(os.getcwd(), 'user_data_dirs')
os.makedirs(user_data_dir_base, exist_ok=True)

# Example Dailymotion channel URL
dailymotion_channel_url = 'https://www.dailymotion.com/kevin930321'  # Replace with your channel URL

# Function to fetch the most recent Dailymotion video URL from a channel using Selenium
def fetch_latest_dailymotion_video_url(channel_url):
    options = webdriver.ChromeOptions()
    options.add_argument('--headless')  # Run in headless mode
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')

    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    driver.get(channel_url)
    time.sleep(5)  # Wait for the page to fully load

    soup = BeautifulSoup(driver.page_source, 'html.parser')
    driver.quit()

    # Print out the HTML content for debugging
    # logger.info("Fetched HTML content:")
    # logger.info(soup.prettify())

    video_link = None
    try:
        # Find the first <a> tag with data-testid="video-card"
        video_card = soup.find('a', {'data-testid': 'video-card'})
        if video_card:
            video_link = 'https://www.dailymotion.com/playlist/x8iuca'# + video_card['href']
            logger.info(f"Found video link: {video_link}")
        else:
            logger.error("No video card found with data-testid='video-card'")
    except Exception as e:
        logger.error(f"Error retrieving video link: {str(e)}")
    return video_link

url = fetch_latest_dailymotion_video_url(dailymotion_channel_url)

success_count = 0
failure_count = 0

# Function to handle each tab execution with a timeout
def handle_tab_execution(url, user_data_dir, cycle_index):
    global success_count, failure_count

    options = webdriver.ChromeOptions()
    options.add_argument(f"--user-data-dir={user_data_dir}")
    options.add_argument('--no-sandbox') # Bypass OS security model
    options.add_argument('--disable-dev-shm-usage') # Overcome limited resource problems

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
        logger.error(f"Tab ({cycle_index}/{num_cycles}) failed: {str(e)}")
    finally:
        if 'driver' in locals():
            driver.quit()  # Quit the WebDriver

try:
    for i in range(1, num_cycles + 1):
        logger.info(f"Opening tab ({i}/{num_cycles})...")

        # Generate a unique user data directory for each tab
        user_data_dir = os.path.join(user_data_dir_base, f"profile_{i}")

        thread = Thread(target=handle_tab_execution, args=(url, user_data_dir, i))
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
    # Clean up: Delete user data directories
    for j in range(1, num_cycles + 1):
        user_data_dir = os.path.join(user_data_dir_base, f"profile_{j}")
        if os.path.exists(user_data_dir):
            try:
                os.rmdir(user_data_dir)
            except OSError as e:
                logger.error(f"Error deleting user data directory '{user_data_dir}': {str(e)}'")