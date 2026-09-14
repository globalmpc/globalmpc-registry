/**
 * Checksums recorded before migrations were hashed without comments.
 *
 * GENERATED — do not edit by hand. Databases that applied a migration under the old full-text
 * scheme recorded `sha256(file text)`. `full` lists the known texts of each file (the private
 * development tree and the public release differ only in comments); `normalized` is the
 * comment-free checksum of that text. `runMigrations` accepts a recorded `full` value only when
 * the file on disk still normalizes to `normalized`, then rewrites the record.
 */
export interface LegacyChecksum {
  readonly full: readonly string[];
  readonly normalized: string;
}

export const LEGACY_CHECKSUMS: Readonly<Record<string, LegacyChecksum>> = {
  "0001_schema.sql": {
    full: ["3d92c69673a40c62a00bb4527e208d336126816eb78ba01724e14e2bd3549fdc", "d2e92f7c0cc62535d91b5920245b4e1875ba409df5956178c3d1a385b27ad9a4"],
    normalized: "a70510e5a887d8d9706be3b7e7666c6d2ca14e41041679e1f6d9bfc85d23f290",
  },
  "0002_rls.sql": {
    full: ["c68ac16dc89809b32a1246b182d148910b0d158732743f040f1a82c6814106a5"],
    normalized: "fa0c97417a62635a334392c5df8d6429362eb0eeef1066e90c84084f7d3ca310",
  },
  "0003_guards.sql": {
    full: ["9f83bacc9ef46227ec7fe7c0c1854588cab32d4d08c05eea47677fda7b8245b6"],
    normalized: "d9337958a20351fc10cc3ba6c4d5bbcb6a0917efede11d19815be204ae9d8e06",
  },
  "0004_siwe_nonce.sql": {
    full: ["23c45b892cea17952d0a92354c148804658afeda8b6f8da2364203cc65e25a5b"],
    normalized: "bd69285831edf68c02b7804a308537a389382055e0b4e12f3aa719f3968fd656",
  },
  "0005_session_resolver.sql": {
    full: ["5f974378655de332b6e35e28e2473eea04b0199926013f9ec5ff9240dd022a5f"],
    normalized: "da77415418ed03e8af8a01cebe8956e24ec81aff38def9478808e2541ce2c6e4",
  },
  "0006_tenant_scoped_fk.sql": {
    full: ["d08ad22938293b8446a2c4502f12572873114c4a73a7e78fb5a3b473c97f7f7c"],
    normalized: "f252fecd2a7f5b60c40f3d89f9b780e8ae0f15685172361f99c4ab61d059e47c",
  },
  "0007_object_uploads.sql": {
    full: ["ed8cc99335ccc857bbb7013de7065bef8956542c8841d6657e64d5dd496924c4"],
    normalized: "2ec46e0f6db569e1049b631486cc9bce9d65f6dbd296b1aa0b621eed1fc9e403",
  },
  "0008_signature_requests.sql": {
    full: ["ce722a5e3153920ac02999768ffd76113207196004ee16c71808dbfe95f952ca", "e847b956e09cb5d9b76979c01c5146c781412cd83c12af90fe29a651c1ef1214"],
    normalized: "8cfa210a04bffd8c41537b5b1d0881ccfcd68ed87cdfb89c6dd037333c8f685c",
  },
  "0009_public_read.sql": {
    full: ["ff0ffbbdddb3f40af92faaac395db644e3a5a68d828404b3060ac50769d9030d", "62dd209df4c3ffce6617ef53e0cf744903fd018c56864a4bc826bbaefed1d7e5"],
    normalized: "a7e95163f6caab369b454872738f16ab792351023e8a33bd2a12d344ba8dfc9c",
  },
  "0010_sessions.sql": {
    full: ["9fe50f78d1ab8b46aeae7866273da8a8e935c5b80f6bae2972a640c5a54678d1"],
    normalized: "30b3cd59fe9c456be9638d662cac7eeae27b2ee91c1db1c384758c4bb846bf63",
  },
  "0011_verification_case_claims.sql": {
    full: ["e09425181d88c78a4dc20ff0e80f7d7bacddbd927c1d1f848bf693a720c5d4e7"],
    normalized: "d7678dd7c0ced2d4d52867122af78ff2204b15ab4d0b42bd5dfb3a210a2fb46c",
  },
  "0012_chain_submission.sql": {
    full: ["f600baef83199301773248a6145fe2c6bbbbb2fb3c97593f7f257ac89777ec4f", "79bb43084d0eca7b942c2134b687c3a887bd5ef9f4d723590757579cd064c4db"],
    normalized: "f02cffd04b90f6fb421be8139b237fd016b3b87f27f92239b5c5593842e501f1",
  },
  "0013_case_transitions.sql": {
    full: ["58446c6c6cd8ae5e8d942d6fc804e5f2d27a555dd34b47be9b0ed4e347180c83", "08f5b23348459e96e43544fcf8d70610cd210e4c3f133af81b555f7fc49a3ebd"],
    normalized: "93d2679862f32df0d4c49d774b62f5a7090977435489e420c455331d383e2f23",
  },
  "0014_anchor_proposals.sql": {
    full: ["f6edd4f707de24200a757ad5adb100b894a1d4d9a2b07a166dbfc2098146b54f", "6026e6bf93d49c80a55205c304a7c6cec92c92e7de5dd9e01357425cb5030531"],
    normalized: "450c1157ae1d4ee36119ba79ca28c0e64eda3a7a161ffcf9ae9e53f59f1247e5",
  },
  "0015_scan_attempts.sql": {
    full: ["612379d2a68f4827d30884abc9bf949f20390bd11751ca07ef205420e995c3c1", "d7f4cee2e24886cc19ed10255a4638e83682531cd34871c6b89a24751988dd96"],
    normalized: "9f3e1c63c032c673ac04e385e12fff2df303198129d3bccf9ebb182da6a8cc9f",
  },
  "0016_scan_lease.sql": {
    full: ["a2b5c60e3544d0588c29970f8c01661ec206f98fb575467c18497c46afbd7573", "28f4a0a3165b1fc2894a0959fb951db1d80289310f8fc88e5777d3f20aa71601"],
    normalized: "572f53e128a022a4c2ae695e1dcd0226aa6e9fc26d85e6ecf45dcf5f06f1891f",
  },
  "0017_governance.sql": {
    full: ["f45461952998971199abc3262abd372b076718f75d840d9374e41e68985c09e5", "25b2f1c2ab04c04f7abebb48810bebafcfc585d7380398758aa34a5f5072330d"],
    normalized: "441028680aa9d360a577b6c8dc9e294f2e82a04dd4433cf5fad8c40761acd1c4",
  },
  "0018_vote_snapshot.sql": {
    full: ["a95baeea4ba13864c10223008e5b9d08aeef6a50a7b9223ea5e360d0c15455a1", "1e10fdd7a8b3f53332bdbb54d707098568a6ec3dadf7d0b4b616b7fde4563164"],
    normalized: "59d40982ce0b704d720fb861ef501dac40dc2ca72192d7ed71d8fe5db4f2d39c",
  },
  "0019_adapter_config.sql": {
    full: ["334839bd1766b676997e22a8acd5a9dcee9b1758bc067418792a8b2112ad0419", "d2d5e6e4ee18b16397c616ca32e6dd3bccf1accedd5cd9b3c4fe2729755dc958"],
    normalized: "353cfd5dc1e30883e5dbf8e077a934149d5330820c75b8dc4bc33470f275fe6e",
  },
  "0020_authority_registry.sql": {
    full: ["fb185e84f499630aaf0861b78fef68a8130d55ebb388fed0e0e9b3cedb1cc96f", "3142f5c45414224ec60705370a84bd47e02d96d1d7d09cd12f3ec3131a0f20ae"],
    normalized: "3f41cbcc39f7d55ff6b5458ab567995032d187d33aafebd1396a857b3be037ac",
  },
  "0021_evidence_channels.sql": {
    full: ["712520f080277b0e738f70ac2df7da5e36c5b0331d50ced34572c7026af5e325", "b2b48ac51507057b8e5efb64cc9adade26cded6f09d603770286706ea6f9cd21"],
    normalized: "17e66cddf316a3b4d227f49e40ee25ed6738ead5c284f47d2a92b9fa692e59bd",
  },
  "0022_storage_tier.sql": {
    full: ["fd39a6280baf44e15447637d0769a565f0e02f4dcb7bc60042310f27a0d31edf"],
    normalized: "7d69798fa6a1aad866185addd6dac647ce8fb1e46b9cf0823ec95317e094736b",
  },
  "0023_stale_propagation.sql": {
    full: ["19dc33c0166f1d72aa411ae937ccd9650a5979a2740c34a3c55103b8a92315c4", "c341286103eef2257a04ed3d54bae24984c132ab5237335f9a93f72624064664"],
    normalized: "4abdfab9140feab933e7c7cf465ec69870b443ce58970a3d5ea87356ae345ea4",
  },
  "0024_stale_signals.sql": {
    full: ["8144322ea852910a80812b27f3b581852ad14847163ef4afc47cbc17c9e39384", "67e578f4b0c905622bd1b0b684ff7d1417dc7dd55f30cac44623cab3b1b27dbb"],
    normalized: "618e41e8a221f38dd92038be0824460aeb349ecaf5521e77da4c74283ea164e4",
  },
  "0025_eligible_weight.sql": {
    full: ["39bd635c029d40fd8b8b31424a5967990d010ccdf9accaed3629cd6f5d1fb220", "45f085a608821e3ead51fe6c76648af99efe706c08bc2b3880087c539b860356"],
    normalized: "23036c97f06a410b8c84f9f6c50ea38341c54fcb3616591aaa85b9270c6289f7",
  },
  "0026_role_binding_order.sql": {
    full: ["573ce9104f2fcb3e0795d043c6f9ce594a2d15e27e1c6a3a8cc88b09a7536146"],
    normalized: "5a772ad91db1a84339de3de22a44dc4ac57dd549bb0be48a2e50f6668656c5bb",
  },
  "0027_public_governance_disclosures.sql": {
    full: ["b2b38c24e29b9dde5b516a874eaf4eb765bcebaa64a2626709b9f657da204eac", "48cd9e9c3bc8bdbe15a798b5b60ab2e1fca7daa91e147a4f221a2940b8a62927"],
    normalized: "dce6b0a1880fd83fb107e867d41235f0b2dacd13e796351ddb390cd76cc1572d",
  },
  "0028_role_grant_requests.sql": {
    full: ["ab0908c41bd770cf92a9430f202f03fee0a80fde2c195cca5a4e44e6c5cd7fef", "cb05f208477f94782ea5e5e6e7fa0e648f87100ed03dfedd1d1ba395167b45ae"],
    normalized: "1912afad22f81bb51670b5d056facb96b6032a054d35f11f4e0d0d7853a3046c",
  },
  "0029_operational_gauges.sql": {
    full: ["c7a5db98e1396d07b782776ab37fd645812dacbb31f8bfcb3f7e7bfdffc6eb82", "9e310ee61f12ba5ad80f3609b37f435889484c36341ca933719355cbe9c6872e"],
    normalized: "41a620a5949e0940060c873a969de9104100dbe03b1c89c6046fe3c8ca5adeaa",
  },
  "0030_notifications.sql": {
    full: ["80732e89de1061d367d078dee0fb9d8fe60ec1b091ed0391404742f059e3711f", "53fa5b2353f12ddb2654fe492818f428cf9a938b306a6706e9b10ac095e8634a"],
    normalized: "eb8b6ad1179fffe7dce4c4e8991c3757f0988c61aa0621cc5cef1c3b39c3d848",
  },
  "0031_project_lifecycle_transitions.sql": {
    full: ["da2b7a52599cd224a3e4cc6aa5270fa313c80cccc3cd27a4beb9cca0f45e0c01", "a93aeb0b69301b6a9ea50338224ec6b1a87984449dfd8fe575de3d7a1d0e7eb8"],
    normalized: "0526387f333f5f605529b7fea56c87bb62d7cecf60e81f0fec2e83110a22f691",
  },
  "0032_worker_heartbeats.sql": {
    full: ["39f87d180b3d5a2251386f3995893fc43cfd30910bfd3b3fc32556b8141c1ed7", "4c65a013433435cf1051474025c320a7619fc84db3b4a91a177697d205110326"],
    normalized: "82114ce44bd6925a122d9629ca9a807d0bdf40e90cba5e1c766d87b0e5a03298",
  },
  "0033_notification_sinks.sql": {
    full: ["cb209a281152a8f82548c37ee6322eb35796c955cfcdef8e6e795a44873faff9", "bcb86d5efb5770325a447bf47bd2e6d1c30cf4ae1d0b007c515b8d76113652aa"],
    normalized: "92e140ac31e71212d67e2e01b7538eaae0819c74851aadfbe9fb3ebb12a68b46",
  },
  "0034_public_registry_list.sql": {
    full: ["3248be92b5332bb6281248ac9fe167508ce341988c3db56d70be5686cfbe1467", "548c0b3e21baaf149ed17d7f0d600a4bec5b22184b9c896b37ba94fd43a38a7d"],
    normalized: "1751da23a7eaaf4f5f5c7e9e219329ef7385cbe2c5241e7f0f26253378480ca2",
  },
  "0035_public_disclosure_granularity.sql": {
    full: ["2f667a3766c4474f163001e0dcbde9984d795469c88927e063b6ab2bda2931ed", "1cae8bbd31bf5e4d177466dbd5f1e140a6a1f5f08a40cfdaddd8e94fea11b318"],
    normalized: "2d22a612276e810e708097a41ad5802284fea77a7cfe9bc647449183ed215958",
  },
  "0036_proof_versions.sql": {
    full: ["e1f314030487240faf0364f7043baa5f5c555e90a89a7bbc019fa4ae2a60f26f", "539666382cd2c84ffd05f37af20dc5df69ab7c89fdec67cb132a7bf5cac38246"],
    normalized: "44320b99a772783727669c07f9e3873e05b15285802f695afae36d44b6ac5c0a",
  },
  "0037_source_response_profile.sql": {
    full: ["31f4f2600eefeb62fcb74e36ba63b39c91961ad9130f0e216b747b7969871ac9"],
    normalized: "a6190f636072b31644668ae4ae3e623527666cec0407e3e796acc746e43e18ab",
  },
  "0038_confirmation_binding.sql": {
    full: ["337ae0c17e01364cb914efccc230911fbac1367c4fe31e5e223efae22a587508"],
    normalized: "bba147fb490bee6f978db05b990e4515c4a9dca23d32486453524556a5158ec8",
  },
  "0039_confirmation_binding_null_safe.sql": {
    full: ["2a55347e8ebdca57bd6121048ca673cef3e523cfdff3b97a81f71cb446983230"],
    normalized: "e5c513c01dc9a33e94aa9646b228775142136af4b1d5584130cad3297549194c",
  },
  "0040_public_hash_lookup.sql": {
    full: ["e63ee16aa95ba4546d13b0599b2f39028a2e5a4ac42a06a6c8a51389a402dfb5", "d0cf5953d22a95e8c7cba0d0a33af7e703cfcec2877b218a40db0292ce787daf"],
    normalized: "583813f87e291313f4cbdd79599c57ec818417beee09e56d58d1e401c80b28f1",
  },
};
