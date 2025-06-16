require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const admin = require('firebase-admin');

// Initialize Firebase
let firebaseInitialized = false;
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : {};
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://vrctcg-default-rtdb.firebaseio.com/'
    });
    firebaseInitialized = true;
    console.log('Firebase initialized for Discord bot');
} catch (error) {
    console.error('Firebase initialization error for bot:', error.message);
}

const db = firebaseInitialized ? admin.database() : null;
const giftedRef = db ? db.ref('gifted') : null;

// Discord Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Replace with Application ID
const GUILD_ID = process.env.GUILD_ID; // Replace with Server ID
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID; // Original role for command access
const APPROVER_ROLE_ID = process.env.APPROVER_ROLE_ID; // Role for approving commands
const CHANNEL_ID = process.env.CHANNEL_ID; // Replace with target channel ID

// Define Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('givepack')
        .setDescription('Give a pack to a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to give the pack to')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('packid')
                .setDescription('The ID of the pack')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Number of packs (default: 1)')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    new SlashCommandBuilder()
        .setName('givepoints')
        .setDescription('Give points to a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to give points to')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Amount of points to give')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    new SlashCommandBuilder()
        .setName('checkgifts')
        .setDescription('Check all gifted data')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
].map(command => command.toJSON());

// Register Slash Commands
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error.message);
    }
})();

// Bot Event: Ready
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// Bot Event: Interaction Create
client.on('interactionCreate', async interaction => {
    // Handle Slash Commands
    if (interaction.isChatInputCommand()) {
        // Restrict to specific channel
        if (interaction.channelId !== CHANNEL_ID) {
            await interaction.reply({ content: `This command can only be used in the specified channel.`, ephemeral: true });
            return;
        }

        // Check if user has ADMIN_ROLE_ID
        if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
            await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            return;
        }

        if (!firebaseInitialized || !giftedRef) {
            await interaction.reply({ content: 'Database unavailable. Please try again later.' });
            return;
        }

        // Create approval message with buttons
        const commandData = {
            commandName: interaction.commandName,
            userId: interaction.user.id,
            options: interaction.options.data.map(opt => ({ name: opt.name, value: opt.value }))
        };
        const commandDescription = getCommandDescription(commandData);
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`approve_${interaction.id}`)
                    .setLabel('Approve')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reject_${interaction.id}`)
                    .setLabel('Reject')
                    .setStyle(ButtonStyle.Danger)
            );

        await interaction.reply({
            content: `Proposed command: ${commandDescription}\nAwaiting approval from <@&${APPROVER_ROLE_ID}>.`,
            components: [row]
        });

        // Store pending command
        pendingCommands.set(interaction.id, commandData);
    }

    // Handle Button Interactions
    if (interaction.isButton()) {
        const [action, commandId] = interaction.customId.split('_');

        // Check if user has APPROVER_ROLE_ID
        if (!interaction.member.roles.cache.has(APPROVER_ROLE_ID)) {
            await interaction.reply({ content: 'You do not have permission to approve or reject commands.', ephemeral: true });
            return;
        }

        const commandData = pendingCommands.get(commandId);
        if (!commandData) {
            await interaction.reply({ content: 'This command proposal has expired or was already processed.', ephemeral: true });
            return;
        }

        if (action === 'approve') {
            try {
                await executeCommand(commandData, interaction);
                await interaction.update({
                    content: `Command approved and executed: ${getCommandDescription(commandData)}`,
                    components: []
                });
            } catch (error) {
                await interaction.update({
                    content: `Error executing command: ${error.message}`,
                    components: []
                });
            }
        } else if (action === 'reject') {
            await interaction.update({
                content: `Command rejected: ${getCommandDescription(commandData)}`,
                components: []
            });
        }

        pendingCommands.delete(commandId);
    }
});

// Store pending commands
const pendingCommands = new Map();

// Helper: Get command description
function getCommandDescription(commandData) {
    const { commandName, options } = commandData;
    if (commandName === 'givepack') {
        const user = options.find(opt => opt.name === 'user').value;
        const packid = options.find(opt => opt.name === 'packid').value;
        const amount = options.find(opt => opt.name === 'amount')?.value || 1;
        return `/givepack <@${user}> ${packid} ${amount}`;
    } else if (commandName === 'givepoints') {
        const user = options.find(opt => opt.name === 'user').value;
        const amount = options.find(opt => opt.name === 'amount').value;
        return `/givepoints <@${user}> ${amount}`;
    } else if (commandName === 'checkgifts') {
        return `/checkgifts`;
    }
    return `/${commandName}`;
}

// Helper: Execute approved command
async function executeCommand(commandData, interaction) {
    const { commandName, options } = commandData;

    if (commandName === 'givepack') {
        const userId = options.find(opt => opt.name === 'user').value;
        const packid = options.find(opt => opt.name === 'packid').value;
        const amount = options.find(opt => opt.name === 'amount')?.value || 1;

        if (amount < 1) {
            throw new Error('Amount must be at least 1.');
        }

        const user = await client.users.fetch(userId);
        const username = user.username;
        const packPath = `${username}/packs/${packid}`;
        await giftedRef.child(packPath).set(amount);
        console.log(`[givepack] Set ${packPath} to ${amount}`);

    } else if (commandName === 'givepoints') {
        const userId = options.find(opt => opt.name === 'user').value;
        const amount = options.find(opt => opt.name === 'amount').value;

        if (amount < 0) {
            throw new Error('Amount cannot be negative.');
        }

        const user = await client.users.fetch(userId);
        const username = user.username;
        const currencyPath = `${username}/currency`;
        await giftedRef.child(currencyPath).set(amount);
        console.log(`[givepoints] Set ${currencyPath} to ${amount}`);

    } else if (commandName === 'checkgifts') {
        const snapshot = await giftedRef.once('value');
        const giftedData = snapshot.val() || {};
        const formattedData = JSON.stringify(giftedData, null, 2);
        if (formattedData.length > 1900) {
            const buffer = Buffer.from(formattedData, 'utf-8');
            await interaction.followUp({
                content: 'Gifted data is too large to display here. Sending as a file.',
                files: [{ attachment: buffer, name: 'gifted_data.json' }]
            });
        } else {
            await interaction.followUp({ content: `\`\`\`json\n${formattedData}\n\`\`\`` });
        }
        console.log('[checkgifts] Returned gifted data');
    }
}

// Login to Discord
client.login(BOT_TOKEN).catch(error => {
    console.error('Failed to login to Discord:', error.message);
});