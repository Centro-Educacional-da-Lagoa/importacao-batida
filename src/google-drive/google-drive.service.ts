import { Injectable } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { Readable } from 'stream';

@Injectable()
export class GoogleDriveService {
  private driveClient: drive_v3.Drive;
  private folderId: string;

  constructor() {
    if (
      !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
      !process.env.GOOGLE_PRIVATE_KEY ||
      !process.env.GOOGLE_DRIVE_FOLDER_ID
    ) {
      throw new Error(
        'Missing Google Drive environment variables. Check GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_DRIVE_FOLDER_ID.',
      );
    }

    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    this.driveClient = google.drive({ version: 'v3', auth });
    this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  }

  async uploadOrUpdateFile(
    fileName: string,
    content: string,
    mimeType: string,
  ): Promise<{ id: string; webViewLink: string }> {
    const formattedContent = content.replace(/\\r\\n/g, '\n');
    try {
      // 1. Check if file already exists
      const existingFile = await this.findFileByName(fileName);

      const fileMetadata = {
        name: fileName,
        parents: !existingFile ? [this.folderId] : undefined,
      };

      const media = {
        mimeType,
        body: Readable.from(formattedContent),
      };

      if (existingFile && existingFile.id) {
        // 2. Update existing file
        console.log(
          `Updating existing file in Google Drive: ${fileName} (ID: ${existingFile.id})`,
        );
        const response = await this.driveClient.files.update({
          fileId: existingFile.id,
          media: media,
          requestBody: fileMetadata,
          fields: 'id, webViewLink',
        });

        if (!response.data || !response.data.id || !response.data.webViewLink) {
          throw new Error(
            'Failed to update file: Invalid response from Google Drive API',
          );
        }
        console.log(`File updated successfully. ID: ${response.data.id}`);
        return { id: response.data.id, webViewLink: response.data.webViewLink };
      } else {
        // 3. Create new file
        console.log(`Creating new file in Google Drive: ${fileName}`);
        const response = await this.driveClient.files.create({
          requestBody: fileMetadata,
          media: media,
          fields: 'id, webViewLink',
        });

        if (!response.data || !response.data.id || !response.data.webViewLink) {
          throw new Error(
            'Failed to create file: Invalid response from Google Drive API',
          );
        }
        console.log(`File created successfully. ID: ${response.data.id}`);
        return { id: response.data.id, webViewLink: response.data.webViewLink };
      }
    } catch (error) {
      console.error('Google Drive API Error:', error);
      throw new Error(
        `Failed to upload or update file on Google Drive: ${
          error.message || 'Unknown error'
        }`,
      );
    }
  }

  private async findFileByName(
    fileName: string,
  ): Promise<drive_v3.Schema$File | null> {
    try {
      const response = await this.driveClient.files.list({
        q: `'${this.folderId}' in parents and name = '${fileName}' and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive',
      });

      if (response.data.files && response.data.files.length > 0) {
        return response.data.files[0];
      }

      return null;
    } catch (error) {
      console.error(`Error finding file ${fileName} in Google Drive:`, error);
      throw error;
    }
  }
}
