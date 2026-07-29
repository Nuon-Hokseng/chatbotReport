# Use the exact official Microsoft Playwright image matching your Playwright version
# This image comes pre-loaded with every single Linux system dependency Chromium needs
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

# Set working directory inside the container
WORKDIR /app

# Copy package files and install your node modules
COPY package*.json ./
RUN npm install

# Copy your actual scraper code
COPY . .

# Expose the API port
EXPOSE 3000

# Command to run your scraper API
CMD ["node", "index.js"]
