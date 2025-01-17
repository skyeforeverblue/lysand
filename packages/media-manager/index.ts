import { rm } from "node:fs/promises";
import { S3Client } from "@jsr/bradenmacdonald__s3-lite-client";
import type { Config } from "config-manager";
import { MediaConverter } from "./media-converter";

export enum MediaBackendType {
    LOCAL = "local",
    S3 = "s3",
}

interface UploadedFileMetadata {
    uploadedFile: File;
    path: string;
    hash: string;
}

export class MediaHasher {
    /**
     * Returns the SHA-256 hash of a file in hex format
     * @param media The file to hash
     * @returns The SHA-256 hash of the file in hex format
     */
    public async getMediaHash(media: File) {
        const hash = new Bun.SHA256()
            .update(await media.arrayBuffer())
            .digest("hex");

        return hash;
    }
}

export class MediaBackend {
    constructor(
        public config: Config,
        public backend: MediaBackendType,
    ) {}

    static async fromBackendType(
        backend: MediaBackendType,
        config: Config,
    ): Promise<MediaBackend> {
        switch (backend) {
            case MediaBackendType.LOCAL:
                return new LocalMediaBackend(config);
            case MediaBackendType.S3:
                return new S3MediaBackend(config);
            default:
                throw new Error(`Unknown backend type: ${backend as string}`);
        }
    }

    public getBackendType() {
        return this.backend;
    }

    public shouldConvertImages(config: Config) {
        return config.media.conversion.convert_images;
    }

    /**
     * Fetches file from backend from SHA-256 hash
     * @param file SHA-256 hash of wanted file
     * @param databaseHashFetcher Function that takes in a sha256 hash as input and outputs the filename of that file in the database
     * @returns The file as a File object
     */
    public getFileByHash(
        file: string,
        databaseHashFetcher: (sha256: string) => Promise<string>,
    ): Promise<File | null> {
        return Promise.reject(
            new Error("Do not call MediaBackend directly: use a subclass"),
        );
    }

    public deleteFileByUrl(url: string): Promise<void> {
        return Promise.reject(
            new Error("Do not call MediaBackend directly: use a subclass"),
        );
    }

    /**
     * Fetches file from backend from filename
     * @param filename File name
     * @returns The file as a File object
     */
    public getFile(filename: string): Promise<File | null> {
        return Promise.reject(
            new Error("Do not call MediaBackend directly: use a subclass"),
        );
    }

    /**
     * Adds file to backend
     * @param file File to add
     * @returns Metadata about the uploaded file
     */
    public addFile(file: File): Promise<UploadedFileMetadata> {
        return Promise.reject(
            new Error("Do not call MediaBackend directly: use a subclass"),
        );
    }
}

export class LocalMediaBackend extends MediaBackend {
    constructor(config: Config) {
        super(config, MediaBackendType.LOCAL);
    }

    public async addFile(file: File) {
        let convertedFile = file;
        if (this.shouldConvertImages(this.config)) {
            const mediaConverter = new MediaConverter();
            convertedFile = await mediaConverter.convert(
                file,
                this.config.media.conversion.convert_to,
            );
        }

        const hash = await new MediaHasher().getMediaHash(convertedFile);

        const newFile = Bun.file(
            `${this.config.media.local_uploads_folder}/${hash}/${convertedFile.name}`,
        );

        if (await newFile.exists()) {
            // Already exists, we don't need to upload it again
            return {
                uploadedFile: convertedFile,
                path: `${hash}/${convertedFile.name}`,
                hash: hash,
            };
        }

        await Bun.write(newFile, convertedFile);

        return {
            uploadedFile: convertedFile,
            path: `${hash}/${convertedFile.name}`,
            hash: hash,
        };
    }

    public async deleteFileByUrl(url: string) {
        // url is of format https://base-url/media/SHA256HASH/FILENAME
        const urlO = new URL(url);

        const hash = urlO.pathname.split("/")[1];

        const dirPath = `${this.config.media.local_uploads_folder}/${hash}`;

        try {
            await rm(dirPath, { recursive: true });
        } catch (e) {
            console.error(`Failed to delete directory at ${dirPath}`);
            console.error(e);
        }

        return;
    }

    public async getFileByHash(
        hash: string,
        databaseHashFetcher: (sha256: string) => Promise<string | null>,
    ): Promise<File | null> {
        const filename = await databaseHashFetcher(hash);

        if (!filename) return null;

        return this.getFile(filename);
    }

    public async getFile(filename: string): Promise<File | null> {
        const file = Bun.file(
            `${this.config.media.local_uploads_folder}/${filename}`,
        );

        if (!(await file.exists())) return null;

        return new File([await file.arrayBuffer()], filename, {
            type: file.type,
            lastModified: file.lastModified,
        });
    }
}

export class S3MediaBackend extends MediaBackend {
    constructor(
        config: Config,
        private s3Client = new S3Client({
            endPoint: config.s3.endpoint,
            useSSL: true,
            region: config.s3.region || "auto",
            bucket: config.s3.bucket_name,
            accessKey: config.s3.access_key,
            secretKey: config.s3.secret_access_key,
        }),
    ) {
        super(config, MediaBackendType.S3);
    }

    public async deleteFileByUrl(url: string) {
        // url is of format https://s3-base-url/SHA256HASH/FILENAME
        const urlO = new URL(url);

        const hash = urlO.pathname.split("/")[1];
        const filename = urlO.pathname.split("/")[2];

        await this.s3Client.deleteObject(`${hash}/${filename}`);

        return;
    }

    public async addFile(file: File) {
        let convertedFile = file;
        if (this.shouldConvertImages(this.config)) {
            const mediaConverter = new MediaConverter();
            convertedFile = await mediaConverter.convert(
                file,
                this.config.media.conversion.convert_to,
            );
        }

        const hash = await new MediaHasher().getMediaHash(convertedFile);

        await this.s3Client.putObject(
            `${hash}/${convertedFile.name}`,
            convertedFile.stream(),
            {
                size: convertedFile.size,
            },
        );

        return {
            uploadedFile: convertedFile,
            path: `${hash}/${convertedFile.name}`,
            hash: hash,
        };
    }

    public async getFileByHash(
        hash: string,
        databaseHashFetcher: (sha256: string) => Promise<string | null>,
    ): Promise<File | null> {
        const filename = await databaseHashFetcher(hash);

        if (!filename) return null;

        return this.getFile(filename);
    }

    public async getFile(filename: string): Promise<File | null> {
        try {
            await this.s3Client.statObject(filename);
        } catch {
            return null;
        }

        const file = await this.s3Client.getObject(filename);

        return new File([await file.arrayBuffer()], filename, {
            type: file.headers.get("Content-Type") || "undefined",
        });
    }
}

export { MediaConverter };
